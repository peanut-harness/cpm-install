/**
 * Public Lite product catalog trust anchors. These keys are separate from the
 * CPM CLI release anchors and private keys are never stored in this repository.
 * Keep both entries during the documented rotation window.
 */
export const LITE_PRODUCT_TRUST_ANCHORS = Object.freeze([
    Object.freeze({
        keyId: 'lite-product-2026-01',
        algorithm: 'ed25519',
        format: 'spki-der-base64',
        value: 'MCowBQYDK2VwAyEA921TJlGPUY94iCWQLXwAUd91N5jjLvVzpBu4N6Bd3EA=',
    }),
    Object.freeze({
        keyId: 'lite-product-2026-02',
        algorithm: 'ed25519',
        format: 'spki-der-base64',
        value: 'MCowBQYDK2VwAyEA8QYkbsxtF8712tJ4tnB5GCE13SmRbE9Ml8x6LXxjws8=',
    }),
]);
