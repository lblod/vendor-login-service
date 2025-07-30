import { v4 as uuid } from 'uuid';
import * as mas from '@lblod/mu-auth-sudo';
import * as rst from 'rdf-string-ttl';
import * as env from '../env';
import { NAMESPACES as ns } from '../env';
import * as sjp from 'sparqljson-parse';
import * as N3 from 'n3';
const { literal } = N3.DataFactory;
const BATCH_SIZE = parseInt(env.SESSION_CLEANUP_BATCH_SIZE || "100");

/*
 * Logs a client in: verifies that the API key is correct for the organisation and publisher, removes stale logins, and creates a new session.
 *
 * @public
 * @async
 * @function
 * @param {N3.Store} store - A store that encodes the details from the login request.
 * @returns {N3.Store} A new store with only the propeties that represent a session.
 */
export async function login(store) {
  const organization = store.getObjects(undefined, ns.pav`createdBy`)[0];
  const publisher = store.getObjects(undefined, ns.pav`providedBy`)[0];
  const key = store.getObjects(publisher, ns.muAccount`key`)[0];
  const session = store.getSubjects(ns.rdf`type`, ns.session`Session`)[0];

  // Check credentials in the database and throw error if not found
  const organizationID = await verifyPublisherKeyOrganisation(
    publisher,
    key,
    organization,
  );
  if (!organizationID)
    throw new Error(
      'Authentication failed, vendor does not have access to the organization or does not exist. If this should not be the case, please contact us at digitaalABB@vlaanderen.be for login credentials.',
    );

  // Remove sessions already linked to the account for the current session, to remove stale sessions.
  await removeAllSessions(session);

  // Create session in the database and capture the details
  const loginDetailsStore = await createSession(
    session,
    publisher,
    organization,
  );

  return loginDetailsStore;
}

/*
 * Log a client out: remove all of its sessions.
 *
 * @async
 * @public
 * @function
 * @param {NamedNode} session - Represents the session IRI that needs to be logged out.
 * @returns {undefined} Nothing
 */
export async function logout(session) {
  return removeAllSessions(session);
}

/*
 * Verify the authentication of a client by verifying the combination of identification and API key as their credentials.
 *
 * @async
 * @function
 * @param {NamedNode} publisher - Represents the publisher/vendor IRI.
 * @param {Literal} key - The API key for this client.
 * @param {NamedNode} organization - Represents the organization IRI the publisher can act on behalf of.
 * @returns {Literal|undefined} Returns either a Literal representing the (mu:)uuid of the organisation as a means of showing the credentials are found and correct, or `undefined` when the credentials are not correct.
 */
async function verifyPublisherKeyOrganisation(publisher, key, organization) {
  // NOTE: the graph has been remove from this query because we just don't know it. This data is written per organisation graph but a sudo query will get the data.
  const response = await mas.querySudo(`
    ${env.SPARQL_PREFIXES}
    SELECT DISTINCT ?organizationID WHERE  {
      ${rst.termToString(publisher)}
        a foaf:Agent;
        muAccount:key ${rst.termToString(key)};
        muAccount:canActOnBehalfOf ${rst.termToString(organization)}.
      ${rst.termToString(organization)}
        mu:uuid ?organizationID.
    }`);
  const parser = new sjp.SparqlJsonParser();
  const parsedResults = parser.parseJsonResults(response);
  return parsedResults[0]?.organizationID;
}

/*
 * Remove all sessions for the account (=vendor) that this session is linked to.
 *
 * @async
 * @function
 * @param {NamedNode} session - Represents a session that is linked to an account where all the session will be removed from.
 * @returns {undefined} Nothing
 */
async function removeAllSessions(session) {
  // NOTE: same note as above about the graphs.
  // Remove all sessions for this account, not just previous session for this session URI, beause we can get stale sessions otherwise.
  // The downside to this approach is that there can only be one client logged in per account (=vendor). Is this even a downside?

  // somehow, a lot of sessions were found by this query (e.g. in LMB 20250730), which resulted in this call failing.
  // so we're batching it now and this avoids the issue.
  let batch = undefined;
  const parser = new sjp.SparqlJsonParser();
  const safeSession = rst.termToString(session);
  while(batch === undefined || batch.length > 0) {
    const batchResult = await mas.querySudo(`
      ${env.SPARQL_PREFIXES}
      SELECT DISTINCT ?session WHERE {
        GRAPH ?g {
          ${safeSession}
            a session:Session ;
            muAccount:account ?account .

          ?session
            a session:Session ;
            muAccount:account ?account ;
            muAccount:canActOnBehalfOf ?org;
            mu:uuid ?id .

          FILTER (?session != ${safeSession}).
        }
      } LIMIT ${BATCH_SIZE}
    `);
    const parsedResults = parser.parseJsonResults(batchResult);
    batch = parsedResults.map((result) => result.session);
    if( batch.length > 0 ){
      const safeBatchExceptTarget = batch.map((s) => rst.termToString(s))
        .join('\n');
      await mas.updateSudo(`
      ${env.SPARQL_PREFIXES}
      DELETE {
        GRAPH ?g {
          ?session
            a session:Session ;
            muAccount:account ?account ;
            dct:created ?created ;
            muAccount:canActOnBehalfOf ?org;
            mu:uuid ?id .
        }
      }
      WHERE {
        GRAPH ?g {
          VALUES ?session {
            ${safeBatchExceptTarget}
          }

          ?session
            muAccount:account ?account ;
            a session:Session ;
            muAccount:canActOnBehalfOf ?org;
            dct:created ?created ;
            mu:uuid ?id .
        }
      }
    `);
    }
  }

  // After removing all sessions, we also remove the session itself, so that it is not lingering around.
  await mas.updateSudo(`
    ${env.SPARQL_PREFIXES}
    DELETE {
      GRAPH ?g {
        ?session
          a session:Session ;
          muAccount:account ?account ;
          dct:created ?created ;
          muAccount:canActOnBehalfOf ?org;
          mu:uuid ?id .
      }
    }
    WHERE {
      GRAPH ?g {
        VALUES ?session {
          ${safeSession}
        }

        ?session
          muAccount:account ?account ;
          a session:Session ;
          muAccount:canActOnBehalfOf ?org;
          dct:created ?created ;
          mu:uuid ?id .
      }
    }
  `);
}

/*
 * Create a session for an account (=vendor) for a certain session IRI from the identifier.
 *
 * @async
 * @function
 * @param {NamedNode} session - Represents the session IRI from the identifier.
 * @param {NamedNode} account - Represents the account, or the vendor, where session can be created for.
 * @param {NamedNode} organization - Represents the organization, or the bestuurseenheid, where session can be linked to.
 * @returns {N3.Store} Returns a new store with only the properties that contain information about the newly created session.
 */
async function createSession(session, account, organization) {
  const store = new N3.Store();
  const sessionId = literal(uuid());
  const now = literal(new Date().toISOString(), ns.xsd`dateTime`);
  store.addQuad(session, ns.rdf`type`, ns.session`Session`);
  store.addQuad(session, ns.mu`uuid`, sessionId);
  store.addQuad(session, ns.dct`created`, now);
  store.addQuad(session, ns.muAccount`account`, account);
  await mas.updateSudo(`
    ${env.SPARQL_PREFIXES}
    INSERT {
      GRAPH ?g {
        ${rst.termToString(session)}
          a session:Session ;
          mu:uuid ${rst.termToString(sessionId)} ;
          dct:created ${rst.termToString(now)} ;
          muAccount:account ${rst.termToString(account)} ;
          muAccount:canActOnBehalfOf ${rst.termToString(organization)} .
      }
    }
    WHERE {
      GRAPH ?g {
        ${rst.termToString(account)} a ?type .
      }
    }
  `);
  return store;
}
