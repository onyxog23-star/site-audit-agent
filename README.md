# Site Audit Agent

An AI agent that audits any website and explains what to fix, in plain English.

Paste a URL, and in about 30–60 seconds you get:

- **An overall score and grade**, plus a short summary for a business owner
- **Google PageSpeed scores** (mobile): performance, accessibility, best practices, SEO
- **The top 5 fixes**, ranked by impact and effort ("quick win", "moderate", "larger project")
- **Raw checks**: title, meta description, headings, alt text, broken links, HTTPS, sitemap and more
- **The agent's own decisions**: which extra pages it chose to inspect, and why
- **Download as PDF** to send to a client

## How it works

```
Browser ──► /api/audit (Vercel serverless function, keys stay here)
              1. Fetch the page + run code checks (SEO, links, mobile, HTTPS)
              2. Start Google PageSpeed test in parallel
              3. AI agent picks up to 3 important pages to inspect (contact, services…)
              4. Inspect those pages
              5. AI writes a structured report from the facts only
         ◄── JSON report rendered as a clean page
```

The checks are done by code, so the numbers are real. The AI's role is to decide what to look at next and to explain the results. It is told to use only the facts it was given.

**Stack:** plain HTML/CSS/JS frontend, one Node.js serverless function, Google Gemini API, Google PageSpeed Insights API. No dependencies and no build step.

## Setup (about 20 minutes, all free)

### 1. Get your keys
- **Gemini:** go to [aistudio.google.com](https://aistudio.google.com), click **Get API key**, then **Create API key**.
- **PageSpeed (optional, but it gives higher limits):** go to [console.cloud.google.com](https://console.cloud.google.com), create a project, enable **PageSpeed Insights API**, then go to **Credentials → Create credentials → API key**.

### 2. Put the code on GitHub
Create a new repository named `site-audit-agent` and upload all the files from this folder.
Do **not** upload a `.env` file. `.gitignore` already keeps it out.

### 3. Deploy on Vercel
1. Sign in at [vercel.com](https://vercel.com) with your GitHub account.
2. Click **Add New → Project** and import `site-audit-agent`.
3. Before you deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | your Gemini key |
| `PAGESPEED_API_KEY` | your PageSpeed key (optional) |
| `ACCESS_CODE` | a password, so only you can run audits (recommended) |

4. Click **Deploy**. Your agent is now live at `https://site-audit-agent-xxxx.vercel.app`.

Every time you push a change to GitHub, Vercel updates the site automatically.

## Run it on your own computer (optional)

```bash
cp .env.example .env      # then paste your keys into .env
node dev-server.js        # open http://localhost:3000
```

This needs Node.js 18 or newer.

## Settings

| Variable | What it does |
|---|---|
| `GEMINI_MODEL` | Which Gemini model to use (default `gemini-2.5-flash`). Change it here if Google renames or retires the model. |
| `ACCESS_CODE` | If set, the page asks for this code before running an audit. |

## Files

```
index.html       the page you see (form, progress, report)
api/audit.js     the agent: checks, page selection, report writing
vercel.json      gives the function up to 60 seconds to run
dev-server.js    local test server
.env.example     template for your keys (copy it to .env, and never commit .env)
```

## Ideas for v2
- Crawl the whole site instead of only the top pages
- Save past audits and compare scores over time
- Custom branding on the PDF for client reports
- Check desktop speed as well as mobile

---
Built by Sangliana Khiangte · MIT License
