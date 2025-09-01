#!/usr/bin/env node

import argon2 from "argon2";

const SPARQL_ENDPOINT = process.env.SPARQL_ENDPOINT || "http://virtuoso:8890/sparql";
const GRAPH_URI = "http://mu.semte.ch/graphs/automatic-submission";

async function getKeys() {
  const query = `
    PREFIX muAccount: <http://mu.semte.ch/vocabularies/account/>
    SELECT ?subject ?key WHERE {
      GRAPH <${GRAPH_URI}> {
        ?subject muAccount:key ?key .
      } 
    }
  `;

  const response = await fetch(SPARQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      "Accept": "application/sparql-results+json"
    },
    body: query,
  });

  const data = await response.json();
  return data.results.bindings.map(b => ({
    subject: b.subject.value,
    key: b.key.value
  }));
}

async function updateKeys(entries) {
  const entriesWithHash = await Promise.all(
    entries.map(async ({ subject, key }) => ({
      subject,
      key,
      hashed: await argon2.hash(key),
    }))
  );
  return `
PREFIX muAccount: <http://mu.semte.ch/vocabularies/account/>
DELETE {
  GRAPH <${GRAPH_URI}> {
    ?subject muAccount:key ?key .
  }
}
INSERT {
  GRAPH <${GRAPH_URI}> {
    ?subject muAccount:keyHash ?keyHash .
  }
}
WHERE {
  VALUES (?subject ?key ?keyHash) {
    ${entriesWithHash
      .map(
        ({ subject, key, hashed }) =>
          `(<${subject}> "${key}" "${hashed}")`
      )
      .join("\n        ")}
  }
}
  `; // TODO: We might want to use proper escaping for the variables
}

async function main() {
  console.log("Fetching keys...");
  const entries = await getKeys();
  const migrationString = await updateKeys(entries);
  console.log("Migration content:");
  console.log("==================");
  console.log(migrationString);
  console.log("==================================================================================");
  console.log("> Copy the text above to a new migration file and restart the migration service. <");
  console.log("==================================================================================");
}

main().catch((err) => {
  console.error("Error:", err);
});
