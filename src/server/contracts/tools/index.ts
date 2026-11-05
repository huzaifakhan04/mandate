/**
 * Importing this module registers every tool, in this file's order — the
 * registry's iteration order follows this list. REST, MCP, OpenAPI, and
 * tests all import this module (not individual tool files) so the registry
 * is populated the same way everywhere.
 */
import "./getBankGuide";
import "./registerAgent";
import "./getStatus";
import "../../services/notes"; // registers the note_purchase capture handler before confirm_checkout can dispatch to it
import "./buyNotes";
import "./confirmCheckout";
import "./redeemNotes";
