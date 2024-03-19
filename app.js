import { app } from 'mu';
import bodyParser from 'body-parser';
import { NAMESPACES as ns } from './env';
import { v4 as uuid } from 'uuid';
import * as jsonld from 'jsonld';
import * as vl from './lib/vendor-login';
import * as con from './lib/contexts';
import * as N3 from 'n3';
const { namedNode, literal, blankNode } = N3.DataFactory;

app.use(bodyParser.json());

app.post('/sessions', async function (req, res, next) {
  try {
    ensureValidContentType(req.get('content-type'));
    ensureMinimalLoginHeaders(req);
    const enrichedBody = enrichLoginJsonld(req.body);
    const store = await jsonLdToStore(enrichedBody);
    ensureMinimalLoginPayload(store);
    addSessionUriToStore(req, store);
    const loginDetailsStore = await vl.login(store);
    const jsonLdObject = await storeToJsonLd(
      loginDetailsStore,
      con.LoginResponseContext,
      con.LoginResponseFrame,
    );
    res
      .status(201)
      .header('mu-auth-allowed-groups', 'CLEAR')
      .json(jsonLdObject);
  } catch (e) {
    next(e);
  }
});

app.delete('/sessions/current', async function (req, res, next) {
  try {
    ensureMinimalLoginHeaders(req);
    const sessionUri = req.get('Mu-Session-Id');
    vl.logout(namedNode(sessionUri));
    res.status(204).header('mu-auth-allowed-groups', 'CLEAR').end();
  } catch (e) {
    next(e);
  }
});

///////////////////////////////////////////////////////////////////////////////
// Error handler
///////////////////////////////////////////////////////////////////////////////

// For some reason the 'next' parameter is unused and eslint notifies us, but when removed, Express does not use this middleware anymore.
/* eslint-disable no-unused-vars */
app.use(async (err, req, res, next) => {
  res.status(err.status || 400);
  const errorStore = errorToStore(err);
  const errorJsonld = await storeToJsonLd(
    errorStore,
    con.ErrorResponseContext,
    con.ErrorResponseFrame,
  );
  res.json(errorJsonld);
});
/* eslint-enable no-unused-vars */

///////////////////////////////////////////////////////////////////////////////
// Helpers
///////////////////////////////////////////////////////////////////////////////

/*
 * Make sure the incoming request has the content type(s) this service can respond to.
 *
 * @function
 * @param {String} contentType - The string that contains the 'Content-Type' header information from the request.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error with a message if the content type(s) is/are not supported.
 */
function ensureValidContentType(contentType) {
  if (!/application\/(ld\+)?json/.test(contentType))
    throw new Error(
      'Content-Type not valid, only application/json or application/ld+json are accepted',
    );
}

/*
 * During the login and logout process, we need to make sure there is a mu-session-id header (and potentially others) in the request, otherwise the identifier didn't do its job properly or was not contacted during this request. Without these headers, the login an logout is not possible.
 *
 * @function
 * @param {Request} req - This is the ExpressJS request object for the login or logout requests.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error if one of the request headers is missing, because the process can not be completed.
 */
function ensureMinimalLoginHeaders(req) {
  if (!req.get('Mu-Session-Id'))
    throw new Error(
      'The required "mu-session-id" header could not be found. This is usually attached to the request by the mu-identifier.',
    );
}

/*
 * Add some of the necessary properties to an object to make sure it can be properly converted to RDF data and to make sure all the necessary data is present. These are only properties that can be added as default such as the context.
 *
 * @function
 * @param {Object} requestBody - Most likely this is the body of the request as a JSON object.
 * @returns {Object} The same object as the input object, but with some properties added.
 */
function enrichLoginJsonld(requestBody) {
  requestBody['@context'] = requestBody['@context'] || con.LoginRequestContext;
  requestBody['@type'] = requestBody['@type'] || [
    'wotSec:APIKeySecurityScheme',
    'lblodAuth:LoginRequest',
  ];
  return requestBody;
}

/*
 * Ensue the minimal set of properties is supplied when making a login request. These properties are the organization, the publisher and the API key.
 *
 * @function
 * @param {N3.Store} store - A quad store that contains the RDF data for a login request.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error if at least on of the properties are missing from the request.
 */
function ensureMinimalLoginPayload(store) {
  const organizationExists = store.some(
    (quad) => quad,
    undefined,
    ns.pav`createdBy`,
  );
  if (!organizationExists)
    throw new Error('The payload is missing an organization field');

  const publisher = store.getObjects(undefined, ns.pav`providedBy`)[0];
  if (!publisher)
    throw new Error(
      'The payload is missing a publisher object with URI and key',
    );

  const key = store.getObjects(publisher, ns.muAccount`key`)[0];
  if (!key)
    throw new Error('The payload is missing its API key for the publisher');
}

/*
 * Produces an RDF store with the data to encode an error in the OSLC namespace.
 *
 * @function
 * @param {Error} errorObject - Instance of the standard JavaScript Error class or similar object that has a `message` property.
 * @returns {N3.Store} A new Store with the properties to represent the error.
 */
function errorToStore(errorObject) {
  const store = new N3.Store();
  const error = blankNode(uuid());
  store.addQuad(error, ns.rdf`type`, ns.oslc`Error`);
  store.addQuad(error, ns.mu`uuid`, literal(uuid()));
  store.addQuad(error, ns.oslc`message`, literal(errorObject.message));
  return store;
}

/*
 * Adds the `mu-session-id` as an entity to the store with its RDF type.
 *
 * @function
 * @param {Request} req - ExpressJS request object where the `mu-session-id` header can be found.
 * @param {N3.Store} store - A store where the properties will be added to.
 * @returns {N3.Store} The given store is returned with properties added. (This is strictly not needed as the store is modified.)
 */
function addSessionUriToStore(req, store) {
  const sessionUri = req.get('Mu-Session-Id');
  store.addQuad(namedNode(sessionUri), ns.rdf`type`, ns.session`Session`);
  return store;
}

/*
 * Converts a JSON-LD JavaScript Object to an RDF.JS store.
 *
 * @async
 * @function
 * @param {Object} jsonLdObject - A JavaScript object that contains JSON-LD structures.
 * @returns {N3.Store} Returns the store that contains the properties from the input object.
 */
async function jsonLdToStore(jsonLdObject) {
  const requestQuads = await jsonld.default.toRDF(jsonLdObject, {});
  const store = new N3.Store();
  store.addQuads(requestQuads);
  return store;
}

/*
 * Converts an RDF.JS store to a JSON-LD JavaScript Object performing framing and compacting to produce the most human readable result.
 *
 * @async
 * @function
 * @param {N3.Store} store - A store that contains the properties.
 * @param {Object} context - This object is used to compact the JSON-LD object to contain more consice property names and to use namespace prefixes.
 * @param {Object} frame - This object is used to frame the object, i.e. to enforce a specific tree structure in the produced object.
 * @returns {Object} Returns a fully compacted and framed JSON-LD object with the data from the store.
 */
async function storeToJsonLd(store, context, frame) {
  const jsonld1 = await jsonld.default.fromRDF([...store], {});
  const framed = await jsonld.default.frame(jsonld1, frame);
  const compacted = await jsonld.default.compact(framed, context);
  return compacted;
}
