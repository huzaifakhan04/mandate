/**
 * Importing this module registers every tool, in this file's order — the
 * registry's iteration order follows this list. REST, MCP, OpenAPI, and
 * tests all import this module (not individual tool files) so the registry
 * is populated the same way everywhere.
 */
import "./getBankGuide";
import "./registerAgent";
import "./getStatus";
import "./registerPublicKey";
import "../../services/notes"; // registers the note_purchase capture handler before confirm_checkout can dispatch to it
import "../../services/repayments"; // registers the repayment_link/repayment_direct capture handlers and the invoice-link activation hook
import "./buyNotes";
import "./confirmCheckout";
import "./redeemNotes";
import "./checkEligibility";
import "./applyForLoan";
import "./acceptOffer";
import "./declineOffer";
import "./getApplication";
import "./getLoan";
import "./repayLoan";
import "./getStatement";
