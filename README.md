# Dust Bunny Leaderboard Bot

A Discord bot that fetches circle data from [uma.moe](https://uma.moe/api/v4/circles?circle_id=883948934) and displays an auto-updating leaderboard in your server.

## Setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, name it (e.g. "Dust Bunny Leaderboard")
3. Open **Bot** → **Add Bot**
4. Under **Token**, click **Reset Token** and copy it
5. Enable **Message Content Intent** under Privileged Gateway Intents (optional, for future commands)
6. In **OAuth2 → URL Generator**, select scopes: `bot`, `applications.commands`
7. Select Bot permissions: `Send Messages`, `Embed Links`
8. Copy the generated URL, open it in a browser, and invite the bot to your server

### 2. Install and Configure

```bash
npm install
```

Copy `.env.example` to `.env` and set your bot token:

```
DISCORD_BOT_TOKEN=your_bot_token_here
UPDATE_INTERVAL_MINUTES=15
```

### 3. Run the Bot

```bash
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/setup-leaderboard` | Posts the leaderboard embed in the current channel and enables auto-updates |
| `/refresh-leaderboard` | Manually refresh the leaderboard right away |

## How It Works

- The bot fetches data from `https://uma.moe/api/v4/circles?circle_id=883948934`
- When you run `/setup-leaderboard`, it posts an embed and stores the message ID
- Every 15 minutes (configurable via `UPDATE_INTERVAL_MINUTES`), it edits that message with fresh data
- The embed shows circle info (leader, club rank, monthly points) and the top 10 members ranked by current fans
