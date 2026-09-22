/**
 * Public Lite product catalog trust anchors. These keys are separate from the
 * CPM CLI release anchors and private keys are never stored in this repository.
 * The list stays empty until the controlled product signing keys are issued, so
 * every non-empty product catalog fails closed with
 * `cpm_product_trust_anchor_missing`. Keep two entries during rotation.
 */
export const LITE_PRODUCT_TRUST_ANCHORS = Object.freeze([]);
