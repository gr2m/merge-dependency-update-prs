#!/usr/bin/env node

const { Octokit } = require("@octokit/core");
const { paginateRest } = require("@octokit/plugin-paginate-rest");

const REQUIRED_SCOPES = ["repo", "notifications"];
const MyOctokit = Octokit.plugin(paginateRest);

if (!process.env.GITHUB_TOKEN) {
  console.log("GITHUB_TOKEN environment variable not set");
  process.exit(1);
}

const REGEX_DEPENDABOT_TITLE =
  /^(chore|build)\((deps(-dev)?)\): bump \S+ from \d+\.\d+\.\d+ to \d+\.\d+\.\d+/;
const REGEX_RENOVATE_DEPENDENCY_UPDATE_TITLE =
  /^(chore|build|fix)\(deps\): (update .* to v\d+(\.\d+\.\d+)?|lock file maintenance)/;
const REGEX_RENOVATE_ACTION_PIN_UPDATE_TITLE =
  /^ci\(action\): update .* digest to \w{7}/;
const REGEX_PULL_REQUEST_URL =
  /^https:\/\/api.github.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;

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
    const isDependabotPr = REGEX_DEPENDABOT_TITLE.test(
      notification.subject.title
    );

    const isRenovatePr =
      REGEX_RENOVATE_DEPENDENCY_UPDATE_TITLE.test(notification.subject.title) ||
      REGEX_RENOVATE_ACTION_PIN_UPDATE_TITLE.test(notification.subject.title);

    return isDependabotPr || isRenovatePr;
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

  // handle security notifications
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

  // handle PRs
  for (const {
    id: thread_id,
    subject: { url, title },
  } of dependencyUpdateNotifications) {
    if (!REGEX_PULL_REQUEST_URL.test(url)) {
      console.log("Ignoring %s, not a pull request URL", url);
      continue;
    }
    const [, owner, repo, pull_number] = url.match(
      /^https:\/\/api.github.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/
    );
    const htmlUrl = `https://github.com/${owner}/${repo}/pull/${pull_number}`;
    console.log(`Checking ${htmlUrl}`);

    const query = `query($htmlUrl: URI!) {
      resource(url: $htmlUrl) {
        ... on PullRequest {
          state
          author {
            login
          }
          files(first:2) {
            nodes {
              path
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                oid
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

      if (!["dependabot", "renovate"].includes(result.resource.author.login)) {
        console.log(
          `Ignoring. Author "${result.resource.author.login}" is not a known dependency update app`
        );
        continue;
      }

      if (result.resource.state !== "OPEN") {
        console.log(
          `pull request state is "${result.resource.state}". Ignoring`
        );
      } else {
        const [{ commit: lastCommit }] = result.resource.commits.nodes;
        const checkRuns = [].concat(
          ...lastCommit.checkSuites.nodes.map((node) => node.checkRuns.nodes)
        );
        const statuses = lastCommit.status ? lastCommit.status.contexts : [];

        const unsuccessfulCheckRuns = checkRuns
          .filter(
            (checkRun) =>
              checkRun.conclusion !== "SUCCESS" &&
              checkRun.conclusion !== "NEUTRAL"
          )
          .filter((checkRun) => {
            if (["Pika CI", "project-board"].includes(checkRun.name))
              return false;
            return checkRun.conclusion !== null;
          });
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

        // make sure no other reviewer is requesting changes
        // https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
        const reviews = await octokit.paginate(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner,
            repo,
            pull_number,
          }
        );

        const changesRequestedReviews = reviews.filter(
          (review) => review.state === "CHANGES_REQUESTED"
        );

        if (changesRequestedReviews.length) {
          const reviewerLogins = changesRequestedReviews.map(
            (review) => `@${review.user.login}`
          );
          console.log(`Changes requested by: ${reviewerLogins.join(", ")}`);

          continue;
        }

        // https://developer.github.com/v3/pulls/reviews/#create-a-pull-request-review
        console.log("adding review");
        await octokit.request(
          "POST /repos/:owner/:repo/pulls/:pull_number/reviews",
          {
            owner,
            repo,
            pull_number,
            event: "APPROVE",
            commit_id: lastCommit.oid,
          }
        );

        // https://developer.github.com/v3/pulls/#merge-a-pull-request-merge-button
        console.log("merging ...");

        try {
          await octokit.request(
            "PUT /repos/:owner/:repo/pulls/:pull_number/merge",
            {
              owner,
              repo,
              pull_number,
              merge_method: "squash",
              commit_title: getCommitTitle(title, result),
            }
          );
        } catch (error) {
          if (error.status === 405) {
            console.log("pull request was meanwhile rebased, try again later");
            continue;
          }

          console.log(error);
          process.exit();
        }
      }

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

function getCommitTitle(title, result) {
  const matches = title.match(REGEX_DEPENDABOT_TITLE);

  if (!matches) {
    return title;
  }

  const [, scope] = matches;

  // ignore updates to dev dependencies
  if (scope === "deps-dev") {
    return title;
  }

  // change fix commit prefix to build for lock file maintenance PRs
  if (/lock file maintenance/.test(title)) {
    return title.replace(/^fix\(deps\)/, "build(deps)");
  }

  // if `package.json` was updated, we assume it was an out of range update
  const packageJsonWasUpdated = !!result.resource.files.nodes.find(
    (file) => file.path === "package.json"
  );
  if (packageJsonWasUpdated) {
    return title.replace(/^build\(deps\)/, "fix(deps)");
  }

  return title;
}
