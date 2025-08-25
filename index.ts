import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "fs";
import * as yaml from "js-yaml";

const GITHUB_TOKEN = Bun.env.GITHUB_TOKEN;
const GITHUB_USERNAME = Bun.env.GITHUB_USERNAME || "stonega"; // Replace with your username
const OPENAI_ENDPOINT = "https://models.github.ai/inference";

// Add timezone handling
const SHANGHAI_TIMEZONE = 'Asia/Shanghai';

interface PromptConfig {
  name: string;
  description: string;
  model: string;
  modelParameters: {
    temperature: number;
  };
  messages: Array<{
    role: string;
    content: string;
  }>;
}

interface GitHubEvent {
  type: string;
  repo: { name: string };
  payload: any;
  created_at: string;
}

interface ActivityStats {
  commitCount: number;
  repoCount: number;
  prCount: number;
  issueCount: number;
}

function isWithinPastDay(eventDate: string): boolean {
  const now = new Date();
  const shanghaiNow = new Date(now.toLocaleString("en-US", { timeZone: SHANGHAI_TIMEZONE }));
  const oneDayAgo = new Date(shanghaiNow.getTime() - 24 * 60 * 60 * 1000);
  
  const eventDateTime = new Date(eventDate);
  const eventShanghaiTime = new Date(eventDateTime.toLocaleString("en-US", { timeZone: SHANGHAI_TIMEZONE }));
  
  return eventShanghaiTime >= oneDayAgo;
}

function loadPromptConfig(): PromptConfig {
  try {
    const configFile = readFileSync(".prompt.yaml", "utf-8");
    return yaml.load(configFile) as PromptConfig;
  } catch (error) {
    console.error("Error loading .prompt.yaml:", error);
    throw error;
  }
}

async function fetchRecentActivity(): Promise<GitHubEvent[]> {
  const octokit = new Octokit({
    auth: GITHUB_TOKEN,
  });

  try {
    // First, get user info to identify personal repositories
    const { data: userInfo } = await octokit.rest.users.getByUsername({
      username: GITHUB_USERNAME,
    });

    const { data: events } = await octokit.rest.activity.listPublicEventsForUser({
      username: GITHUB_USERNAME,
      per_page: 100, // Get more events to account for filtering by time
    });

    // Filter out organization repositories and only keep events from past 24 hours
    const recentPersonalEvents = events.filter((event: any) => {
      // Check if the repo belongs to the user (not an organization)
      const repoOwner = event.repo.name.split('/')[0];
      const isPersonalRepo = repoOwner === userInfo.login;
      
      // Check if event is within past 24 hours (Shanghai timezone)
      const isRecent = isWithinPastDay(event.created_at);
      
      return isPersonalRepo && isRecent;
    });

    console.log(`📊 Filtered ${events.length} total events to ${recentPersonalEvents.length} personal repo events from past 24 hours (Shanghai time)`);
    
    return recentPersonalEvents as GitHubEvent[];
  } catch (error) {
    console.error("Error fetching GitHub activity:", error);
    throw error;
  }
}

function calculateActivityStats(events: GitHubEvent[]): ActivityStats {
  const stats: ActivityStats = {
    commitCount: 0,
    repoCount: 0,
    prCount: 0,
    issueCount: 0
  };

  const uniqueRepos = new Set<string>();

  for (const event of events) {
    uniqueRepos.add(event.repo.name);

    switch (event.type) {
      case "PushEvent":
        stats.commitCount += event.payload.commits?.length || 0;
        break;
      case "PullRequestEvent":
        if (event.payload.action === 'opened') {
          stats.prCount++;
        }
        break;
      case "IssuesEvent":
        if (event.payload.action === 'opened') {
          stats.issueCount++;
        }
        break;
    }
  }

  stats.repoCount = uniqueRepos.size;
  return stats;
}

function generateBadges(stats: ActivityStats): string {
  const badges = [
    `![Recent Commits](https://img.shields.io/badge/Recent%20Commits-${stats.commitCount}-blue?style=flat&logoColor=white)`,
    `![Active Repos](https://img.shields.io/badge/Active%20Repos-${stats.repoCount}-green?style=flat&logoColor=white)`,
    `![Pull Requests](https://img.shields.io/badge/Pull%20Requests-${stats.prCount}-orange?style=flat&logoColor=white)`,
    `![Issues Opened](https://img.shields.io/badge/Issues%20Opened-${stats.issueCount}-red?style=flat&logoColor=white)`
  ];

  return badges.join(' ');
}

function formatActivityForAI(events: GitHubEvent[]): string {
  const now = new Date();
  const shanghaiTime = now.toLocaleString("en-US", { 
    timeZone: SHANGHAI_TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  let formattedActivity = `GitHub Activity from the Past 24 Hours (as of ${shanghaiTime} Shanghai time):\n\n`;
  
  if (events.length === 0) {
    formattedActivity += "No recent activity in personal repositories during the past 24 hours.\n";
    return formattedActivity;
  }
  
  for (const event of events) {
    const eventDate = new Date(event.created_at);
    const shanghaiEventTime = eventDate.toLocaleString("en-US", { 
      timeZone: SHANGHAI_TIMEZONE,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const repo = event.repo.name;
    
    switch (event.type) {
      case "PushEvent":
        const commits = event.payload.commits?.length || 0;
        formattedActivity += `- ${shanghaiEventTime}: Pushed ${commits} commit(s) to ${repo}\n`;
        break;
      case "CreateEvent":
        const refType = event.payload.ref_type;
        formattedActivity += `- ${shanghaiEventTime}: Created ${refType} in ${repo}\n`;
        break;
      case "IssuesEvent":
        const action = event.payload.action;
        formattedActivity += `- ${shanghaiEventTime}: ${action} issue in ${repo}\n`;
        break;
      case "PullRequestEvent":
        const prAction = event.payload.action;
        formattedActivity += `- ${shanghaiEventTime}: ${prAction} pull request in ${repo}\n`;
        break;
      case "WatchEvent":
        formattedActivity += `- ${shanghaiEventTime}: Starred ${repo}\n`;
        break;
      case "ForkEvent":
        formattedActivity += `- ${shanghaiEventTime}: Forked ${repo}\n`;
        break;
      case "ReleaseEvent":
        formattedActivity += `- ${shanghaiEventTime}: Released in ${repo}\n`;
        break;
      default:
        formattedActivity += `- ${shanghaiEventTime}: ${event.type} in ${repo}\n`;
    }
  }
  
  return formattedActivity;
}

async function generateSummary(activity: string, config: PromptConfig): Promise<string> {
  const client = new OpenAI({ 
    baseURL: OPENAI_ENDPOINT, 
    apiKey: GITHUB_TOKEN 
  });

  // Build messages from config, replacing {{input}} placeholder
  const messages = config.messages.map(msg => ({
    role: msg.role,
    content: msg.content.replace('{{input}}', activity)
  }));

  try {
    const response = await client.chat.completions.create({
      messages: messages as any,
      temperature: config.modelParameters.temperature,
      top_p: 1.0,
      model: config.model,
      max_tokens: 200
    });

    return response.choices[0]?.message.content?.trim() || "No summary generated.";
  } catch (error) {
    console.error("Error generating AI summary:", error);
    throw error;
  }
}

function updateReadme(summary: string, badges: string): void {
  try {
    const readmePath = "README.md";
    let readmeContent = readFileSync(readmePath, "utf-8");
    
    const startMarker = "<!-- GITHUB_ACTIVITY_START -->";
    const endMarker = "<!-- GITHUB_ACTIVITY_END -->";
    
    const startIndex = readmeContent.indexOf(startMarker);
    const endIndex = readmeContent.indexOf(endMarker);
    
    if (startIndex === -1 || endIndex === -1) {
      throw new Error("README.md markers not found. Please add <!-- GITHUB_ACTIVITY_START --> and <!-- GITHUB_ACTIVITY_END --> markers.");
    }
    
    const beforeMarker = readmeContent.substring(0, startIndex + startMarker.length);
    const afterMarker = readmeContent.substring(endIndex);
    
    const shanghaiTime = new Date().toLocaleString("en-US", { 
      timeZone: SHANGHAI_TIMEZONE,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const updatedContent = `${beforeMarker}

## Recent Activity Stats

${badges}

${summary}

*Last updated: ${shanghaiTime} (Shanghai time) *

${afterMarker}`;
    
    writeFileSync(readmePath, updatedContent, "utf-8");
    console.log("✅ README.md updated successfully!");
  } catch (error) {
    console.error("Error updating README:", error);
    throw error;
  }
}

export async function main() {
  try {
    console.log("🚀 Starting GitHub activity summary generation...");
    
    // Load prompt configuration
    console.log("📋 Loading prompt configuration...");
    const config = loadPromptConfig();
    console.log(`✅ Loaded config: ${config.name} - ${config.description}`);
    console.log(`📊 Using model: ${config.model} with temperature: ${config.modelParameters.temperature}`);
    
    // Fetch recent GitHub activity
    console.log("📡 Fetching recent GitHub activity...");
    const events = await fetchRecentActivity();
    console.log(`✅ Found ${events.length} recent events`);
    
    // Calculate activity statistics
    console.log("🔢 Calculating activity statistics...");
    const stats = calculateActivityStats(events);
    console.log(`📈 Stats: ${stats.commitCount} commits, ${stats.repoCount} repos, ${stats.prCount} PRs, ${stats.issueCount} issues`);
    
    // Generate badges
    const badges = generateBadges(stats);
    console.log("🏷️ Generated activity badges");
    
    // Format activity for AI processing
    const formattedActivity = formatActivityForAI(events);
    console.log("📝 Formatted activity data for AI");
    
    // Generate AI summary using config
    console.log("🤖 Generating AI summary using .prompt.yaml config...");
    const summary = await generateSummary(formattedActivity, config);
    console.log("✅ AI summary generated");
    
    // Update README with summary and badges
    console.log("📄 Updating README.md...");
    updateReadme(summary, badges);
    
    console.log("🎉 Process completed successfully!");
    console.log("\nGenerated Badges:");
    console.log(badges);
    console.log("\nGenerated Summary:");
    console.log(summary);
    
  } catch (error) {
    console.error("❌ Error in main process:", error);
    process.exit(1);
  }
}

// Run the script
main().catch((err) => {
  console.error("The script encountered an error:", err);
  process.exit(1);
});
