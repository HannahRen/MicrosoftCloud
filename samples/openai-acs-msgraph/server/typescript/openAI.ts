import fs from 'fs';
import { OpenAIApi, Configuration } from 'openai';
import { QueryData, AzureOpenAIResponse, EmailSmsResponse } from './interfaces';
import fetch from 'cross-fetch';
import './config';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_API_VERSION = process.env.OPENAI_API_VERSION;

async function getAzureOpenAICompletion(systemPrompt: string, userPrompt: string, temperature = 0): Promise<string> {

    if (!OPENAI_API_KEY || !OPENAI_ENDPOINT || !OPENAI_MODEL) {
        throw new Error('Missing Azure OpenAI API key, endpoint, or model in environment variables.');
    }

    // While it's possible to use the OpenAI SDK (as of today) with a little work, we'll use the REST API directly for Azure OpenAI calls.
    // https://learn.microsoft.com/en-us/azure/cognitive-services/openai/reference
    const url = `${OPENAI_ENDPOINT}/openai/deployments/${OPENAI_MODEL}/chat/completions?api-version=${OPENAI_API_VERSION}`;
    const data = {
        max_tokens: 1024,
        temperature,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': `${OPENAI_API_KEY}`,
            },
            body: JSON.stringify(data),
        });

        const completion = await response.json() as AzureOpenAIResponse;
        let content = (completion.choices[0]?.message?.content?.trim() ?? '') as string;
        console.log('Azure OpenAI Output: \n', content);
        if (content && content.includes('{') && content.includes('}')) {
            content = extractJson(content);
        }
        return content;
    }
    catch (e) {
        console.error('Error getting data:', e);
        throw e;
    }
}

async function getOpenAICompletion(systemPrompt: string, userPrompt: string, temperature = 0): Promise<string> {

    if (!OPENAI_API_KEY) {
        throw new Error('Missing OpenAI API key in environment variables.');
    }

    const configuration = new Configuration({ apiKey: OPENAI_API_KEY });

    try {
        const openai = new OpenAIApi(configuration);
        const completion = await openai.createChatCompletion({
            model: 'gpt-3.5-turbo', // gpt-3.5-turbo, gpt-4
            max_tokens: 1024,
            temperature,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        });

        let content = extractJson(completion.data.choices[0]?.message?.content?.trim() ?? '') as string;
        console.log('OpenAI Output: \n', content);
        if (content && content.includes('{') && content.includes('}')) {
            content = extractJson(content);
        }
        return content;
    }
    catch (e) {
        console.error('Error getting data:', e);
        throw e;
    }
}

function callOpenAI(systemPrompt: string, userPrompt: string, temperature = 0) {
    const isAzureOpenAI = OPENAI_API_KEY && OPENAI_ENDPOINT && OPENAI_MODEL;
    if (isAzureOpenAI) {
        return getAzureOpenAICompletion(systemPrompt, userPrompt, temperature);
    }
    else {
        return getOpenAICompletion(systemPrompt, userPrompt, temperature);
    }
}

function extractJson(content: string) {
    const regex = /\{(?:[^{}]|{[^{}]*})*\}/g;
    const match = content.match(regex);

    if (match) {
        return match[0];
    } else {
        return '';
    }
}

async function getSQL(userPrompt: string): Promise<QueryData> {
    // Get the high-level database schema summary to be used in the prompt.
    // The db.schema file could be generated by a background process or the 
    // schema could be dynamically retrieved.
    const dbSchema = await fs.promises.readFile('db.schema', 'utf8');

    const systemPrompt = `
    Assistant is a natural language to SQL bot that returns a JSON object with the SQL query and 
    the parameter values in it. The SQL will query a PostgreSQL database.

    PostgreSQL tables, with their columns:

    ${dbSchema}

    Rules:
    - Convert any strings to a PostgreSQL parameterized query value to avoid SQL injection attacks.
    - Always return a JSON object with the SQL query and the parameter values in it. 
    
    Example JSON object to return: { "sql": "", "paramValues": [] }
    `;

    let queryData: QueryData = { sql: '', paramValues: [], error: '' };
    try {
        const results = await callOpenAI(systemPrompt, userPrompt);
    
        queryData = (results && results.startsWith('{') && results.endsWith('}')) ? 
            JSON.parse(results) : { ...queryData, error: results };
    
        if (isProhibitedQuery(queryData.sql) || isProhibitedQuery(queryData.error)) {
            queryData.sql = '';
            queryData.error = 'Prohibited query.';
        }
    } catch (e) {
        console.log(e);
    }

    return queryData;
}

function isProhibitedQuery(query: string): boolean {
    if (!query) return false;

    const prohibitedKeywords = [
        'insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create', 'replace',
        'information_schema', 'pg_catalog', 'pg_tables', 'pg_namespace', 'pg_class',
        'table_schema', 'table_name', 'column_name', 'column_default', 'is_nullable',
        'data_type', 'udt_name', 'character_maximum_length', 'numeric_precision',
        'numeric_scale', 'datetime_precision', 'interval_type', 'collation_name',
        'grant', 'revoke', 'rollback', 'commit', 'savepoint', 'vacuum', 'analyze'
    ];
    const queryLower = query.toLowerCase();
    return prohibitedKeywords.some(keyword => queryLower.includes(keyword));
}

async function completeEmailSMSMessages(prompt: string, company: string, contactName: string) {
    console.log('Inputs:', prompt, company, contactName);
    
    const systemPrompt = `
    Assistant is a bot designed to help users create email and SMS messages from data and 
    return a JSON object with the message information in it.

    Rules:
    - Generate a subject line for the email message.
    - Use the User Rules to generate the messages. 
    - All messages should have a friendly tone and never use inappropriate language.
    - SMS messages should be in plain text format and no more than 160 characters. 
    - Start the message with "Hi <Contact Name>,\n\n". Contact Name can be found in the user prompt.
    - Add carriage returns to the email message to make it easier to read. 
    - End with a signature line that says "Sincerely,\nCustomer Service".
    - Return a JSON object with the emailSubject, emailBody, and SMS message values in it. 

    Example JSON object: { "emailSubject": "", "emailBody": "", "sms": "" }
    `;

    const userPrompt = `
        User Rules: ${prompt}
        Contact Name: ${contactName}
    `;

    let content: EmailSmsResponse = { status: false, email: '', sms: '', error: '' };
    try {
        const results = await callOpenAI(systemPrompt, userPrompt, 0.5);
        if (results && results.startsWith('{') && results.endsWith('}')) {
            content = { content, ...JSON.parse(results) };
            content.status = true;
        }
        else {
            content.error = results;
        }
    }
    catch (e) {
        console.log(e);
    }

    return content;
}

export { completeEmailSMSMessages, getSQL };