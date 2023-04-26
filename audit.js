import fetch from 'node-fetch';
import cheerio from 'cheerio';
import { google } from 'googleapis';

// import * as dotenv from 'dotenv' // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
// dotenv.config()

const servers = [
    ['http://edgegamers.gameme.com/chat/csgo2', 'TTT'],
    ['http://edgegamers.gameme.com/chat/csgo3', 'JB'],
    ['http://edgegamers.gameme.com/chat/csgo4', 'AWP'],
    ['http://edgegamers.gameme.com/chat/csgo5', 'Surf'],
    ['http://edgegamers.gameme.com/chat/csgo6', 'BHop'],
    ['http://edgegamers.gameme.com/chat/css', 'CSS']
];

const ai_moderation = "https://api.openai.com/v1/moderations";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const RUN_RATE = parseInt(process.env.RUN_RATE);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const RANGE_NAME = 'Sheet1';

const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

export const handler = async (event) => {
    const parsers = [];
    for (const server of servers) {
        parsers.push(async () => {
            const response = await fetch(server[0]);
            const text = await response.text();
            const messages = parseMessages(text).reverse();
            const transcript = messages.map((message) => message.user + ": " + message.message).join('\n');

            let flaggedCategories = await checkFlag(transcript);
            let oldCategories = flaggedCategories;
            if (!flaggedCategories)
                return;
            const users = [];
            for (const message of messages) {
                if (!users.some(user => user.name === message.user))
                    users.push({ name: message.user, link: message.userLink });
            }

            // Some line of the transcript was flagged, use binary search to find the offending line
            let start = 0;
            let end = messages.length;
            let mid = Math.floor((start + end) / 2);
            let tries = 0;

            while (start < end && tries < 10) {
                const transcript = messages.slice(0, mid).map((message) => message.user + ": " + message.message).join('\n');
                flaggedCategories = await checkFlag(transcript);
                if (flaggedCategories) {
                    oldCategories = flaggedCategories;
                    end = mid;
                } else {
                    start = mid;
                }
                if (end - start <= 5)
                    break;
                mid = Math.floor((start + end) / 2);
                tries++;
            }
            const trimmedMessages = messages.slice(start, end).map((message) => message.user + ": " + message.message).join('\n');
            const hook = generateWebhook(oldCategories[0], server[1], trimmedMessages, users);
            await sendWebhook(hook);

            // Add the message to the Google Sheets spreadsheet
            const values = [
                [new Date(), server[1], oldCategories[0], trimmedMessages]
            ];
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: RANGE_NAME,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: values
                },
                insertDataOption: 'INSERT_ROWS'

            });
        });
    }
    await Promise.all(parsers.map((parser) => parser()));

    return {
        statusCode: 200,
        body: "Success!"
    };
}

function parseMessages(text) {
    const messages = [];
    const $ = cheerio.load(text);
    // const table = $('table')[0];
    const tableRows = $('table').children('tbody').children('tr').slice(1, -1);
    let nameCell = 1;
    let messageCell = 2;
    if (tableRows.length === 0)
        return messages;
    if ($(tableRows[0]).children().length >= 4) {
        nameCell++;
        messageCell++;
    }
    for (const row of tableRows) {
        const rowData = $(row).children('td').map((i, cell) => $(cell).text()).get();
        const userLink = $(row).children('td').children('a')[1].attribs.href;
        const result = {
            time: rowData[0],
            user: rowData[nameCell],
            userLink: userLink,
            message: rowData[messageCell]
        }
        const date = Date.parse(result.time);
        const now = Date.now();
        if (now + parseInt(process.env.TIME_OFFSET) - date > RUN_RATE * 1000)
            break;
        messages.push(result);
    }
    return messages;
}

async function checkFlag(text) {
    const request = await fetch(ai_moderation, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            "input": text
        })
    });
    // console.log(await request.text())
    const response = await request.json();
    const result = response.results[0];
    if (!result.flagged)
        return undefined;
    const categories = result.categories;
    const flaggedCategories = Object.keys(categories).filter((category) => categories[category]);
    return flaggedCategories;
}

async function sendWebhook(data) {
    const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
    });
}

const flagColors = {
    "hate": 0x5e5e5e,
    "hate/threatening": 0xff4d4d,
    "self-harm": 0x4b0082,
    "sexual": 0xff99ff,
    "sexual/minors": 0xff69b4,
    "violence": 0x8b0000,
    "violence/graphic": 0x000000
};

function generateWebhook(category, server, messages, users) {
    const color = flagColors[category];
    let titleCased = category.split('/').map((word) => word[0].toUpperCase() + word.slice(1)).join('/');
    titleCased = titleCased[0].toUpperCase() + titleCased.slice(1);

    users = users.filter(user => messages.includes(user.name));
    users = users.map(user => `[${user.name}](${user.link})`).join(', ');

    return {
        "username": `Open A Eye`,
        "avatar_url": "https://seeklogo.com/images/O/open-ai-logo-8B9BFEDC26-seeklogo.com.png",
        "embeds": [
            {
                "author": {
                    "name": `${titleCased} Content - ${server}`,
                },
                "description": `\`\`\`${messages}\`\`\``,
                "color": color,
                "fields": [
                    {
                        "name": "Users",
                        "value": users,
                    }
                ]
            }
        ]
    }
}

await handler();