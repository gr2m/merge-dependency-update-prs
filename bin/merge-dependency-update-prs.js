#!/usr/bin/env node

const { Octokit } = require("@octokit/core");
const { paginateRest } = require("@octokit/plugin-paginate-rest");

const REQUIRED_SCOPES = ["repo", "notifications"];
const MyOctokit = Octokit.plugin(paginateRest);

if (!process.env.GITHUB_TOKEN) {
  console.log("GITHUB_TOKEN environment variable not set");
  process.exit(1);
}

main(
  new MyOctokit({
    auth: process.env.GITHUB_TOKEN,
    previews: ["antiope"],
  })
);

async function main(octokit) {
  const { headers } = await octokit.request("/");
  const scopes = headers["x-oauth-scopes"].split(", ");

  for (const requiredScope of REQUIRED_SCOPES) {
    if (!scopes.includes(requiredScope)) {
      console.log(
        `Provided GITHUB_TOKEN does not include "${requiredScope}" scope`
      );
      process.exit(1);
    }
  }

  // https://developer.github.com/v3/activity/notifications/#list-your-notifications
  console.log("Loading all notifications");
  const notifications = await octokit.paginate("GET /notifications");

  console.log(`${notifications.length} notifications found`);
  const dependencyUpdateNotifications = notifications.filter((notification) => {
    const isDependabotPr = /^build\(deps-dev\): bump \S+ from \d+\.\d+\.\d+ to \d+\.\d+\.\d+$/.test(
      notification.subject.title
    );

    return isDependabotPr;
  });
  console.log(
    `${dependencyUpdateNotifications.length} dependency update pull requests found in notifications`
  );

  const securityVulnerabilityNotifications = notifications.filter(
    (notification) => {
      return /^Potential security vulnerability found/.test(
        notification.subject.title
      );
    }
  );

  console.log(
    `${securityVulnerabilityNotifications.length} security vulnerability notifications found`
  );

  for (const {
    id: thread_id,
    subject: { title },
  } of securityVulnerabilityNotifications) {
    console.log(`Marking "${title}" notification as read`);

    // https://developer.github.com/v3/activity/notifications/#mark-a-thread-as-read
    await octokit.request("PATCH /notifications/threads/:thread_id", {
      thread_id,
    });
  }

  for (const {
    id: thread_id,
    subject: { url, title },
  } of dependencyUpdateNotifications) {
    const [, owner, repo, pull_number] = url.match(
      /^https:\/\/api.github.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/
    );
    const htmlUrl = `https://github.com/${owner}/${repo}/pull/${pull_number}`;
    console.log(`Checking ${htmlUrl}`);

    const query = `query($htmlUrl: URI!) {
      resource(url: $htmlUrl) {
        ... on PullRequest {
          author {
            login
          }
          commits(last: 1) {
            nodes {
              commit {
                checkSuites(first: 100) {
                  nodes {
                    checkRuns(first: 100) {
                      nodes {
                        name
                        conclusion
                        permalink
                      }
                    }
                  }
                }
                status {
                  state
                  contexts {
                    state
                    targetUrl
                    description
                    context
                  }
                }
              }
            }
          }
        }
      }
    }`;

    try {
      const result = await octokit.graphql(query, { htmlUrl });

      if (!["dependabot"].includes(result.resource.author.login)) {
        console.log(
          `Ignoring. Author "${result.resource.author.login}" is not a known dependency update app`
        );
      }

      const [{ commit: lastCommit }] = result.resource.commits.nodes;
      const checkRuns = [].concat(
        ...lastCommit.checkSuites.nodes.map((node) => node.checkRuns.nodes)
      );
      const statuses = lastCommit.status ? lastCommit.status.contexts : [];

      const unsuccessfulCheckRuns = checkRuns.filter(
        (checkRun) => checkRun.conclusion !== "SUCCESS"
      );
      const unsuccessStatuses = statuses.filter(
        (status) => status.state !== "SUCCESS"
      );

      if (unsuccessfulCheckRuns.length || unsuccessStatuses.length) {
        console.log(
          `${
            unsuccessfulCheckRuns.length + unsuccessStatuses.length
          } checks/statuses out of ${
            checkRuns.length + statuses.length
          } are not successful:`
        );

        for (const checkRun of unsuccessfulCheckRuns) {
          console.log(`- Check run by "${checkRun.name}"
              Conclusion: ${checkRun.conclusion}
              ${checkRun.permalink}`);
        }

        for (const status of unsuccessStatuses) {
          console.log(`- Status run by "${status.context}"
              state: ${status.state}
              ${status.targetUrl}`);
        }

        continue;
      }

      // https://developer.github.com/v3/pulls/#merge-a-pull-request-merge-button
      console.log("merging ...");

      await octokit.request(
        "PUT /repos/:owner/:repo/pulls/:pull_number/merge",
        {
          owner,
          repo,
          pull_number,
          merge_method: "squash",
          commit_title: title.replace(/^build\(deps\)/, "fix(deps)"),
        }
      );

      console.log(`Marking "${title}" notification as read`);

      // https://developer.github.com/v3/activity/notifications/#mark-a-thread-as-read
      await octokit.request("PATCH /notifications/threads/:thread_id", {
        thread_id,
      });
    } catch (error) {
      console.log(error);
      process.exit(1);
    }
  }
}
