/**
 * P7: public links to the sponsor-built developer assets, rendered into
 * /agents.md, /llms.txt, the landing page and the README. The Postman ids
 * come from `scripts/sponsors/postman-publish.ts` (it prints them; reruns
 * update the same collection by name, so they stay stable) and the
 * collection itself is committed under docs/sponsors/postman/.
 */
export const POSTMAN_COLLECTION_UID = "60016827-6e5e436c-eaa8-4c76-9df9-4f7f1a71cd58";
export const POSTMAN_WORKSPACE_ID = "81e993e5-c62f-4322-9df4-3fea36d9a08e";
/** The public workspace "Mandate (PayPal AI Hackathon)" (team handle + workspace slug). */
export const POSTMAN_WORKSPACE_URL = "https://www.postman.com/huzaifa-khan-inbox-6271629/mandate-paypal-ai-hackathon";

export const SPONSOR_LINKS = {
  postmanWorkspaceUrl: POSTMAN_WORKSPACE_URL,
  /** The public collection in the "Mandate (PayPal AI Hackathon)" workspace. */
  postmanCollectionUrl: `${POSTMAN_WORKSPACE_URL}/collection/${POSTMAN_COLLECTION_UID}`,
  /** "Run in Postman": forks the public collection into the visitor's workspace. */
  postmanForkUrl:
    `https://god.gw.postman.com/run-collection/${POSTMAN_COLLECTION_UID}` +
    `?action=collection%2Ffork&source=rip_markdown&collection-url=` +
    `entityId%3D${POSTMAN_COLLECTION_UID}%26entityType%3Dcollection%26workspaceId%3D${POSTMAN_WORKSPACE_ID}`,
  /** APIMatic-generated SDKs: an index page (src/app/sdks) linking the zips in public/sdks/. */
  sdksPath: "/sdks",
} as const;
