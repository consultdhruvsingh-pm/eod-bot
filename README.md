# EOD Bot — Setup Guide

A Slack slash command bot that auto-generates EOD reports from Linear. Type `/eod` and instantly see:
- ✅ Tasks completed in the last 24h
- 📝 Tickets you created in the last 24h
- 🔄 Tickets in progress
- 🎯 Top 5 upcoming tasks by priority

---

## Step 1: Get your Linear API Key

1. Go to **https://linear.app/settings/api**
2. Scroll to **"Personal API keys"**
3. Click **"Create key"**, name it `EOD Bot`
4. Copy the key — it starts with `lin_api_`
5. Save it somewhere safe (you'll only see it once)

---

## Step 2: Create your Slack App

1. Go to **https://api.slack.com/apps** → Click **"Create New App"**
2. Choose **"From scratch"**
3. Name it `EOD Bot`, pick your workspace → Click **"Create App"**

### Add Bot Scopes
4. In the left sidebar → **"OAuth & Permissions"**
5. Scroll to **"Scopes" → "Bot Token Scopes"** → Add these:
   - `commands` — to receive slash commands
   - `users:read` — to look up users
   - `users:read.email` — to get user emails (needed to match Linear accounts)
   - `chat:write` — to post messages

### Install the App
6. Scroll up → Click **"Install to Workspace"** → Allow
7. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — save it

---

## Step 3: Deploy to Railway (free, 2 minutes)

Railway is a simple hosting platform. Free tier is plenty for this bot.

1. Go to **https://railway.app** → Sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Push this code to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "Initial EOD bot"
   # Create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/eod-bot.git
   git push -u origin main
   ```
4. In Railway, select your new repo → it will auto-deploy
5. Go to your project → **"Variables"** tab → Add these:
   ```
   LINEAR_API_KEY     = lin_api_your_key_here
   SLACK_BOT_TOKEN    = xoxb-your-token-here
   LINEAR_TEAM_NAME   = Engineering
   ```
6. Go to **"Settings"** → **"Domains"** → Click **"Generate Domain"**
7. Copy your Railway URL, e.g. `https://eod-bot-production.up.railway.app`

---

## Step 4: Create the Slash Command in Slack

1. Go back to **https://api.slack.com/apps** → Your app
2. Left sidebar → **"Slash Commands"** → **"Create New Command"**
3. Fill in:
   - **Command:** `/eod`
   - **Request URL:** `https://YOUR-RAILWAY-URL.up.railway.app/eod`
   - **Short Description:** `Generate your EOD report from Linear`
   - **Usage Hint:** _(leave blank)_
4. Click **"Save"**
5. You'll be prompted to **reinstall the app** — do it

---

## Step 5: Test it!

Go to any Slack channel and type `/eod` — you should see your EOD report appear!

---

## Troubleshooting

**"No Linear account found for..."**  
→ Your Slack email and Linear email must match. Check Linear at linear.app/settings/account.

**"Couldn't retrieve your Slack email"**  
→ Make sure you added the `users:read.email` scope and reinstalled the app.

**Bot doesn't respond**  
→ Check Railway logs (click your deployment → "View Logs") for errors.

**Empty completed/in-progress lists**  
→ Make sure you're assigned to tickets in Linear and they were updated today.

---

## Local Development (optional)

```bash
npm install
cp .env.example .env
# Fill in .env with your real values

# Install ngrok for local tunneling
npx ngrok http 3000

# Set your slash command Request URL to the ngrok URL + /eod
# Then run:
npm run dev
```

---

## How it works

When you type `/eod`, Slack sends a POST to your server. The bot:
1. Gets your Slack email via the Slack API
2. Finds your matching Linear user by email
3. Queries Linear for issues completed or created in the last 24h, what's in progress, and your top 5 upcoming
4. Formats everything into a Slack Block Kit message posted to the channel
