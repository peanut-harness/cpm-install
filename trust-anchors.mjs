/**
 * Public CPM CLI release trust anchors. Private keys are never stored in this
 * repository. Keep both entries during the documented rotation window.
 */
export const CPM_RELEASE_TRUST_ANCHORS = Object.freeze([
    Object.freeze({
        keyId: 'cpm-release-2026-01',
        algorithm: 'ed25519',
        format: 'spki-der-base64',
        value: 'MCowBQYDK2VwAyEAvj6GwLqVzpWm22TI8V2CbK3MZkj7jE5b/eD713SN+h8=',
    }),
    Object.freeze({
        keyId: 'cpm-release-2026-02',
        algorithm: 'ed25519',
        format: 'spki-der-base64',
        value: 'MCowBQYDK2VwAyEATbFfQlCT6C+QkLSJyg74oLGWknOhYFPw8ECxaI417Qs=',
    }),
]);
