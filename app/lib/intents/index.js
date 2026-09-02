// The Stage 1 enum and the registry of intent modules it routes to. Every
// key here is one of the sixteen values llm.intent() is constrained to by
// its grammar (see app/lib/llm.js buildEnumGrammar); brain.js never invents
// a seventeenth.

import todayAgenda from './today_agenda.js';
import dateAgenda from './date_agenda.js';
import nextEvent from './next_event.js';
import freeCheck from './free_check.js';
import whyMissingEvent from './why_missing_event.js';
import unreadFrom from './unread_from.js';
import keywordScan from './keyword_scan.js';
import threadSummary from './thread_summary.js';
import readMessage from './read_message.js';
import draftReply from './draft_reply.js';
import sendConfirmed from './send_confirmed.js';
import createEvent from './create_event.js';
import moveEvent from './move_event.js';
import setReminder from './set_reminder.js';
import listReminders from './list_reminders.js';
import chat from './chat.js';

// Order matters only in that it is the order handed to llm.intent(); it has
// no bearing on priority (the model picks one, not the first match).
export const INTENTS = [
  'today_agenda', 'date_agenda', 'next_event', 'free_check', 'why_missing_event',
  'unread_from', 'keyword_scan', 'thread_summary', 'read_message', 'draft_reply',
  'send_confirmed', 'create_event', 'move_event', 'set_reminder', 'list_reminders',
  'chat',
];

export const registry = {
  today_agenda: todayAgenda,
  date_agenda: dateAgenda,
  next_event: nextEvent,
  free_check: freeCheck,
  why_missing_event: whyMissingEvent,
  unread_from: unreadFrom,
  keyword_scan: keywordScan,
  thread_summary: threadSummary,
  read_message: readMessage,
  draft_reply: draftReply,
  send_confirmed: sendConfirmed,
  create_event: createEvent,
  move_event: moveEvent,
  set_reminder: setReminder,
  list_reminders: listReminders,
  chat,
};

// Two or three example phrasings per intent, deliberately widened across
// calendar and mail wording so Stage 1 sees more than one way each is
// commonly asked. Kept short: this whole block is Stage 1's system prompt,
// separate from (and much smaller than) the persona-prefixed conversation
// Stage 2 and Stage 3 use.
const EXAMPLES = {
  today_agenda: ["what's on my calendar today", "what do I have going on today", "am I busy today"],
  date_agenda: ["what's on my calendar next Tuesday", "what do I have this weekend", "anything going on in October"],
  next_event: ["what's my next appointment", "when's my next dentist appointment", "did you already put the dentist on my calendar"],
  free_check: ['am I free tomorrow at 3', 'is Saturday morning open', 'do I have anything friday evening'],
  why_missing_event: ["why isn't my event showing up", 'I added something but it is not on here, why not', "the calendar seems out of date"],
  unread_from: ['do I have any unread mail from the school', 'anything new from grandma', 'unread messages from mom'],
  keyword_scan: ['search my email for invoice', 'find the message about the field trip', 'look for an email mentioning the party'],
  thread_summary: ['catch me up on the email thread about pickup', 'summarize my emails with the school', 'what has grandma been saying in that thread'],
  read_message: ['read me the email from grandma', 'read that message from the school', 'what does the email from mom say'],
  draft_reply: ["reply and tell them we'll be there", 'write a reply saying yes please', 'draft a response to that email'],
  send_confirmed: ['send it', 'yes, send that', 'go ahead and send the reply'],
  create_event: ['put a dentist appointment on my calendar for next Tuesday at 3', 'add soccer practice friday at 5 to my calendar', 'schedule a call with the bank tomorrow at 10'],
  move_event: ['move my dentist appointment', 'can you move soccer practice to a different day', 'change the time of my haircut'],
  set_reminder: ['remind me to take the chicken out at 6', 'set a reminder to call the plumber tomorrow', 'remind me to sign the school form'],
  list_reminders: ['what are my reminders', 'do I have any reminders', 'what do I still need to do'],
  chat: ["what's the capital of France", 'tell me a fun fact', 'how do I get red wine out of a carpet'],
};

export function buildStage1SystemPrompt() {
  const lines = [
    'You are a router. Read the message and reply with exactly one label from this list, nothing else:',
    INTENTS.join(', '),
    '',
    'Examples:',
  ];
  for (const key of INTENTS) {
    for (const example of EXAMPLES[key] || []) {
      lines.push(`"${example}" -> ${key}`);
    }
  }
  lines.push('', 'If nothing else fits, or it is a general question with no calendar, email, or reminder in it, reply chat.');
  return lines.join('\n');
}
