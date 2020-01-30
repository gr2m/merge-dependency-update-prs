# merge-greenkeeper-prs

> Load Greenkeeper PRs from your notifications, merge the green ones and remove notifications

## Usage

```
GITHUB_TOKEN=... npx merge-greenkeeper-prs
```

## How it works

The code is commented, I hope it's self-explanatory. Please feel free to create an issue if something is not clear.

In a nutshell:

1. Load all your notifications
2. Filter out notifications that look like PRs from Greenkeeper
3. Makes sure that all check runs and status are successful
4. Merges the pull request using the `rebase` merge method
5. Marks the notification as read

### License

[ISC](LICENSE)
