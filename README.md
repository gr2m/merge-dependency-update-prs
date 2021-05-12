# merge-dependency-update-prs

> Load Dependabot & Renovate PRs from your notifications, merge the green ones and remove notifications

## Usage

```
GITHUB_TOKEN=... npx merge-dependency-update-prs
```

## How it works

The code is commented, I hope it's self-explanatory. Please feel free to create an issue if something is not clear.

In a nutshell:

1. Loads all your notifications
2. Filters out notifications that look like PRs from Dependabot or Renovate
3. Makess sure that all checks ran and that the combined status is success
4. Merges the pull request using the `squash` merge method
5. Marks the notification as read

### License

[ISC](LICENSE)
