import { NextResponse } from "next/server";

import collection from "../../../../docs/sponsors/postman/mandate.postman_collection.json";

/**
 * P7: the committed Postman v2.1 collection (written by
 * scripts/sponsors/postman-publish.ts), served for "Import → Link" in
 * Postman and for agents/tools that want it without a Postman account.
 */
export function GET(): NextResponse {
  return NextResponse.json(collection, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": 'inline; filename="mandate.postman_collection.json"',
    },
  });
}
