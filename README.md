# Care Bot

by Mazi Saint Concepts™

WhatsApp customer care bot for businesses with websites. It reads the site, links to the owner's own WhatsApp with a pairing code (no second phone, no QR), and answers customers using Google Gemini (free tier available).

## Run locally

```bash
cp .env.example .env     # fill in DATABASE_URL, GEMINI_API_KEY, ADMIN_TOKEN
npm install
node --env-file=.env src/index.js
```

Open http://localhost:3000, enter your admin token, add a business, wait for the crawl, test in the playground, then link WhatsApp.

## Deploy on Railway

1. Add a Postgres service and a Node service from this repo.
2. Add a **volume** mounted at `/data` and set `SESSIONS_DIR=/data/sessions` (WhatsApp logins live here; without it every redeploy logs the owner out).
3. Set `GEMINI_API_KEY` (copy the same value you use in Postwave), `ADMIN_TOKEN`, `DEFAULT_COUNTRY_CODE`. `GEMINI_MODEL` is optional. `DATABASE_URL` is provided by Railway.
4. Run a single instance (one process per WhatsApp session).

## How the bot stays smart

- Answers only from the crawled website plus the owner's notes. Small sites go into the prompt whole; large ones use keyword retrieval.
- Remembers the last 14 messages of each chat, and merges rapid-fire messages into one answer.
- Matches the customer's language (English, Pidgin, Yoruba, Igbo, Hausa, French...).
- Collects order/booking details, then pings the owner on their own WhatsApp.
- Low confidence or unknown answers are handed to the owner, never guessed.
- If the owner replies from their phone, the bot goes quiet in that chat for 12h. Send `!bot on` or `!bot off` in a chat to control it.

## Learning from the owner's chats

- When WhatsApp is linked, WhatsApp sends recent chat history once. The text of one-to-one chats (last 180 days) is stored, and Gemini writes a playbook: the owner's style, facts they stated, and their real answers to common questions. The playbook is shown (and editable) in the dashboard and is used by the bot ahead of the website.
- Already linked before this feature existed? Press **Disconnect WhatsApp**, then link again, to receive the history. New chats and the owner's new replies are learned automatically every few hours, or press **Learn from my chats now**.
- Groups, status updates and media are not stored.

## Limits to know

- Uses the unofficial WhatsApp Web protocol (Baileys), so ban risk exists. The bot only replies, never sends bulk messages, and limits itself to 25 replies per chat per hour.
- Websites are read directly first. If a site blocks robots or only shows content through JavaScript, the page is opened through the Jina Reader service instead (free, about 20 pages a minute; set `JINA_API_KEY` for more). Anything still unreadable can be pasted into Owner notes.
- It cannot read images or voice notes; it asks the customer to type.
- Gemini's free tier has request limits and Google may use free-tier prompts to improve its products. Customers' messages are sent to Gemini, so use a paid key once real customer data is involved.

## Legal

© 2026 Mazi Saint Concepts. All rights reserved. See [LICENSE](LICENSE). Mazi Saint Concepts™ is a trademark of Mazi Saint Concepts (unregistered). The dashboard includes Terms of Use, a Privacy Policy and a legal notice (footer of `public/index.html`). Care Bot is not affiliated with, endorsed by or sponsored by WhatsApp or Meta. WhatsApp and Meta are trademarks of their respective owners. Gemini is a trademark of Google LLC.

Contact: 07065599931
