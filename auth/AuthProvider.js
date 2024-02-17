const msal = require('@azure/msal-node');
const axios = require('axios');
const { msalConfig, TENANT_SUBDOMAIN, REDIRECT_URI, POST_LOGOUT_REDIRECT_URI } = require('../authConfig');

class AuthProvider {
    config;
    cryptoProvider;

    constructor(config) {
        this.config = config;
        this.cryptoProvider = new msal.CryptoProvider();
    }

    getMsalInstance(msalConfig) {
        return new msal.ConfidentialClientApplication(msalConfig);
    }

    async login(req, res, next, options = {}) {

        req.session.csrfToken = this.cryptoProvider.createNewGuid();

        const state = this.cryptoProvider.base64Encode(
            JSON.stringify({
                csrfToken: req.session.csrfToken,
                redirectTo: '/',
            })
        );

        const authCodeUrlRequestParams = {
            state: state,
            scopes: [],
        };

        const authCodeRequestParams = {
            state: state,

            scopes: [],
        };

        if (!this.config.msalConfig.auth.authorityMetadata) {
            const authorityMetadata = await this.getAuthorityMetadata();
            this.config.msalConfig.auth.authorityMetadata = JSON.stringify(authorityMetadata);
        }

        const msalInstance = this.getMsalInstance(this.config.msalConfig);

        return this.redirectToAuthCodeUrl(
            req,
            res,
            next,
            authCodeUrlRequestParams,
            authCodeRequestParams,
            msalInstance
        );
    }

    async handleRedirect(req, res, next) {
        const authCodeRequest = {
            ...req.session.authCodeRequest,
            code: req.body.code, // authZ code
            codeVerifier: req.session.pkceCodes.verifier, // PKCE Code Verifier
        };

        try {
            const msalInstance = this.getMsalInstance(this.config.msalConfig);
            msalInstance.getTokenCache().deserialize(req.session.tokenCache);

            const tokenResponse = await msalInstance.acquireTokenByCode(authCodeRequest, req.body);

            req.session.tokenCache = msalInstance.getTokenCache().serialize();
            req.session.idToken = tokenResponse.idToken;
            req.session.account = tokenResponse.account;
            req.session.isAuthenticated = true;

            const state = JSON.parse(this.cryptoProvider.base64Decode(req.body.state));
            res.redirect(state.redirectTo);
        } catch (error) {
            next(error);
        }
    }

    async logout(req, res, next) {
        const logoutUri = `${this.config.msalConfig.auth.authority}${TENANT_SUBDOMAIN}.onmicrosoft.com/oauth2/v2.0/logout?post_logout_redirect_uri=${this.config.postLogoutRedirectUri}`;

        req.session.destroy(() => {
            res.redirect(logoutUri);
        });
    }

    /**
     * Prepares the auth code request parameters and initiates the first leg of auth code flow
     * @param req: Express request object
     * @param res: Express response object
     * @param next: Express next function
     * @param authCodeUrlRequestParams: parameters for requesting an auth code url
     * @param authCodeRequestParams: parameters for requesting tokens using auth code
     */
    async redirectToAuthCodeUrl(req, res, next, authCodeUrlRequestParams, authCodeRequestParams, msalInstance) {
        // Generate PKCE Codes before starting the authorization flow
        const { verifier, challenge } = await this.cryptoProvider.generatePkceCodes();

        // Set generated PKCE codes and method as session vars
        req.session.pkceCodes = {
            challengeMethod: 'S256',
            verifier: verifier,
            challenge: challenge,
        };


        req.session.authCodeUrlRequest = {
            ...authCodeUrlRequestParams,
            redirectUri: this.config.redirectUri,
            responseMode: 'form_post', // recommended for confidential clients
            codeChallenge: req.session.pkceCodes.challenge,
            codeChallengeMethod: req.session.pkceCodes.challengeMethod,
        };

        req.session.authCodeRequest = {
            ...authCodeRequestParams,
            redirectUri: this.config.redirectUri,
            code: '',
        };

        try {
            const authCodeUrlResponse = await msalInstance.getAuthCodeUrl(req.session.authCodeUrlRequest);
            res.redirect(authCodeUrlResponse);
        } catch (error) {
            next(error);
        }
    }

    /**
     * Retrieves oidc metadata from the openid endpoint
     * @returns
     */
    async getAuthorityMetadata() {
        const endpoint = `${this.config.msalConfig.auth.authority}${TENANT_SUBDOMAIN}.onmicrosoft.com/v2.0/.well-known/openid-configuration`;
        try {
            const response = await axios.get(endpoint);
            return await response.data;
        } catch (error) {
            console.log(error);
        }
    }
}

const authProvider = new AuthProvider({
    msalConfig: msalConfig,
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT_URI,
});

module.exports = authProvider;
