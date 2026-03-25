import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "fs";
import * as yaml from "js-yaml";

const GITHUB_TOKEN = Bun.env.GITHUB_ACTIVITY_TOKEN || Bun.env.GITHUB_TOKEN;
const GITHUB_USERNAME = Bun.env.GITHUB_USERNAME || "stonega"; // Replace with your username
const OPENAI_ENDPOINT = "https://models.github.ai/inference";

// Add timezone handling
const TIMEZONE = 'Asia/Shanghai';

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

interface RepoActivitySummary {
  repo: string;
  url: string;
  pushes: number;
  commits: number;
  prs: number;
  issues: number;
  releases: number;
  branches: number;
  lastActivityAt: string;
}

function getPushCommitCount(event: GitHubEvent): number {
  if (event.type !== "PushEvent") {
    return 0;
  }

  return event.payload.distinct_size ?? event.payload.size ?? event.payload.commits?.length ?? 0;
}

function isWithinPastWeek(eventDate: string): boolean {
  const now = new Date();
  const shanghaiNow = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const oneWeekAgo = new Date(shanghaiNow.getTime() - 7 * 24 * 60 * 60 * 1000);

  const eventDateTime = new Date(eventDate);
  const eventShanghaiTime = new Date(eventDateTime.toLocaleString("en-US", { timeZone: TIMEZONE }));

  return eventShanghaiTime >= oneWeekAgo;
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
    let userLogin = GITHUB_USERNAME;
    let events: GitHubEvent[] = [];

    if (GITHUB_TOKEN) {
      const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
      userLogin = authenticatedUser.login;

      if (userLogin.toLowerCase() === GITHUB_USERNAME.toLowerCase()) {
        const { data } = await octokit.rest.activity.listEventsForAuthenticatedUser({
          username: userLogin,
          per_page: 100, // Get more events to account for filtering by time
        });

        events = data as GitHubEvent[];
        console.log(`🔐 Using authenticated events for ${userLogin}, including private activity`);
      } else {
        console.warn(
          `⚠️ Authenticated as ${userLogin}, but GITHUB_USERNAME is ${GITHUB_USERNAME}. Falling back to public events for the configured user.`
        );
      }
    }

    if (events.length === 0) {
      const { data } = await octokit.rest.activity.listPublicEventsForUser({
        username: GITHUB_USERNAME,
        per_page: 100, // Get more events to account for filtering by time
      });

      events = data as GitHubEvent[];
      console.log(`🌐 Using public events for ${GITHUB_USERNAME}`);
    }

    // Filter out organization repositories and only keep events from past week
    const recentPersonalEvents = events.filter((event: any) => {
      // Check if the repo belongs to the user (not an organization)
      const repoOwner = event.repo.name.split('/')[0];
      const isPersonalRepo = repoOwner.toLowerCase() === userLogin.toLowerCase();

      // Check if event is within past week (Shanghai timezone)
      const isRecent = isWithinPastWeek(event.created_at);

      return isPersonalRepo && isRecent;
    });

    console.log(`📊 Filtered ${events.length} total events to ${recentPersonalEvents.length} personal repo events from past week (Shanghai time)`);

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
        stats.commitCount += getPushCommitCount(event);
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
  ];

  return badges.join(' ');
}

function summarizeRepoActivity(events: GitHubEvent[]): RepoActivitySummary[] {
  const repoMap = new Map<string, RepoActivitySummary>();

  for (const event of events) {
    const repo = event.repo.name;
    const current = repoMap.get(repo) ?? {
      repo,
      url: `https://github.com/${repo}`,
      pushes: 0,
      commits: 0,
      prs: 0,
      issues: 0,
      releases: 0,
      branches: 0,
      lastActivityAt: event.created_at,
    };

    if (new Date(event.created_at) > new Date(current.lastActivityAt)) {
      current.lastActivityAt = event.created_at;
    }

    switch (event.type) {
      case "PushEvent":
        current.pushes += 1;
        current.commits += getPushCommitCount(event);
        break;
      case "PullRequestEvent":
        current.prs += 1;
        break;
      case "IssuesEvent":
        current.issues += 1;
        break;
      case "ReleaseEvent":
        current.releases += 1;
        break;
      case "CreateEvent":
        if (event.payload.ref_type === "branch") {
          current.branches += 1;
        }
        break;
    }

    repoMap.set(repo, current);
  }

  return [...repoMap.values()].sort((a, b) => {
    const scoreA = a.commits + a.prs * 3 + a.issues * 2 + a.releases * 2 + a.branches;
    const scoreB = b.commits + b.prs * 3 + b.issues * 2 + b.releases * 2 + b.branches;

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });
}

function formatRepoActivityTable(repoSummaries: RepoActivitySummary[]): string {
  if (repoSummaries.length === 0) {
    return "_No repository activity in the past week._";
  }

  const header = [
    "| Project | Commits | Pushes | PRs | Issues | Branches | Releases |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  const rows = repoSummaries.map((summary) =>
    `| [${summary.repo}](${summary.url}) | ${summary.commits} | ${summary.pushes} | ${summary.prs} | ${summary.issues} | ${summary.branches} | ${summary.releases} |`
  );

  return [...header, ...rows].join("\n");
}

function formatActivityForAI(events: GitHubEvent[]): string {
  const now = new Date();
  const shanghaiTime = now.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  let formattedActivity = `GitHub Activity from the Past Week (as of ${shanghaiTime} Shanghai time):\n\n`;

  if (events.length === 0) {
    formattedActivity += "No recent activity in personal repositories during the past week.\n";
    return formattedActivity;
  }

  for (const event of events) {
    const eventDate = new Date(event.created_at);
    const shanghaiEventTime = eventDate.toLocaleString("en-US", {
      timeZone: TIMEZONE,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const repo = event.repo.name;

    switch (event.type) {
      case "PushEvent":
        const commits = getPushCommitCount(event);
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

function updateReadme(summary: string, badges: string, repoTable: string): void {
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
      timeZone: TIMEZONE,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const updatedContent = `${beforeMarker}

## Recent Activity Stats

${badges}

## Weekly Overview

${summary}

## Active Projects

${repoTable}

*Last updated: ${shanghaiTime} auto generated by [GitHub Models](https://github.com/${GITHUB_USERNAME}/${GITHUB_USERNAME})*

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

    // Build repo activity table
    const repoTable = formatRepoActivityTable(summarizeRepoActivity(events));
    console.log("📋 Built Markdown project activity table");

    // Format activity for AI processing
    const formattedActivity = formatActivityForAI(events);
    console.log("📝 Formatted activity data for AI");

    // Generate AI summary using config
    console.log("🤖 Generating AI summary using .prompt.yaml config...");
    const summary = await generateSummary(formattedActivity, config);
    console.log("✅ AI summary generated");

    // Update README with summary and badges
    console.log("📄 Updating README.md...");
    updateReadme(summary, badges, repoTable);

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
