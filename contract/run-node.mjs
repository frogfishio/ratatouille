import fs from "node:fs/promises";
import path from "node:path";
import Topic, { setDebug, setPrint } from "../dist/index.node.js";

const casesPath = process.argv[2] || path.join(process.cwd(), "contract", "cases.tsv");
const source = await fs.readFile(casesPath, "utf8");
const sessions = new Map();

function parseCases(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [session, filter, topic, payload, expectedStatus, expectedSeq] = line.split("\t");
      return { session, filter, topic, payload, expectedStatus, expectedSeq };
    });
}

function getSession(name, filter) {
  let session = sessions.get(name);
  if (!session) {
    session = { filter, topics: new Map() };
    sessions.set(name, session);
  }
  if (session.filter !== filter) {
    throw new Error(`session ${name} changed filter from ${session.filter} to ${filter}`);
  }
  return session;
}

function getTopicState(session, topicName) {
  let topicState = session.topics.get(topicName);
  if (!topicState) {
    const envelopes = [];
    const topic = Topic(topicName, { print: false }).extend((envelope) => {
      envelopes.push(envelope);
    });
    topicState = { topic, envelopes };
    session.topics.set(topicName, topicState);
  }
  return topicState;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

setPrint(false);

for (const testCase of parseCases(source)) {
  const session = getSession(testCase.session, testCase.filter);
  const topicState = getTopicState(session, testCase.topic);
  const before = topicState.envelopes.length;

  setDebug(testCase.filter === "-" ? undefined : testCase.filter);
  topicState.topic(testCase.payload);
  await settle();

  const emitted = topicState.envelopes.length > before;
  if (testCase.expectedStatus === "emit") {
    if (!emitted) {
      throw new Error(`node contract failed: expected emit for ${testCase.session}/${testCase.topic}`);
    }
    const envelope = topicState.envelopes.at(-1);
    if (String(envelope.seq) !== testCase.expectedSeq) {
      throw new Error(
        `node contract failed: expected seq ${testCase.expectedSeq} for ${testCase.session}/${testCase.topic}, got ${envelope.seq}`,
      );
    }
  } else if (emitted) {
    throw new Error(`node contract failed: expected filter for ${testCase.session}/${testCase.topic}`);
  }
}

console.log(`node contract ok: ${parseCases(source).length} cases`);
