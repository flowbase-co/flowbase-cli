import crypto from "node:crypto";
import http from "node:http";
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OAUTH_SERVER = process.env.FLOWBASE_OAUTH_URL;
const CREDENTIALS_DIR = path.join(os.homedir(), ".flowbase");
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, "credentials.json");

interface Credentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  userinfo_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

let cachedMetadata: OAuthMetadata | null = null;

async function fetchOAuthMetadata(): Promise<OAuthMetadata> {
  if (cachedMetadata) return cachedMetadata;

  const response = await fetch(`${OAUTH_SERVER}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`Failed to fetch OAuth metadata: ${response.status}`);
  }

  cachedMetadata = (await response.json()) as OAuthMetadata;
  return cachedMetadata;
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  console.log(`If the browser doesn't open, visit:\n${url}`);

  exec(cmd, (error) => {
    if (error) {
      console.error(`Failed to open browser automatically.`);
    }
  });
}

export function saveCredentials(creds: Credentials): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

export function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return null;
  }
  try {
    const data = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function registerClient(redirectUri: string): Promise<{ clientId: string; clientSecret: string }> {
  const response = await fetch(`${OAUTH_SERVER}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "flowbase-cli",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });

  if (!response.ok) {
    throw new Error(`Client registration failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    client_id: string;
    client_secret: string;
  };

  return { clientId: data.client_id, clientSecret: data.client_secret };
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(`${OAUTH_SERVER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(`${OAUTH_SERVER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

async function authorize(): Promise<{ clientId: string; clientSecret: string; accessToken: string; refreshToken: string }> {
  const { codeVerifier, codeChallenge } = generatePKCE();

  return new Promise((resolve, reject) => {
    let registeredClientId: string;
    let registeredClientSecret: string;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Authorization failed</h1><p>${error}: ${errorDescription}</p></body></html>`);
        server.close();
        reject(new Error(`${error}: ${errorDescription}`));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        server.close();
        reject(new Error("No authorization code received"));
        return;
      }

      try {
        const port = (server.address() as any).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const tokens = await exchangeCode(
          code,
          codeVerifier,
          registeredClientId,
          registeredClientSecret,
          redirectUri
        );

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>"
        );
        server.close();

        resolve({
          clientId: registeredClientId,
          clientSecret: registeredClientSecret,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        });
      } catch (error) {
        res.writeHead(500);
        res.end("Token exchange failed");
        server.close();
        reject(error);
      }
    });

    server.listen(0, "127.0.0.1", async () => {
      try {
        const port = (server.address() as any).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const { clientId, clientSecret } = await registerClient(redirectUri);
        registeredClientId = clientId;
        registeredClientSecret = clientSecret;

        const metadata = await fetchOAuthMetadata();
        const authUrl = new URL(metadata.authorization_endpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");

        console.log("Opening browser for authorization...");
        openBrowser(authUrl.toString());
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
}

export async function getAccessToken(): Promise<string> {
  const creds = loadCredentials();

  // No credentials — run full auth flow
  if (!creds) {
    console.log("No credentials found. Starting authorization...");
    const { clientId, clientSecret, accessToken, refreshToken } = await authorize();

    saveCredentials({
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600 * 1000, // assume 1 hour
    });

    return accessToken;
  }

  // Token still valid
  if (creds.expiresAt > Date.now() + 60_000) {
    return creds.accessToken;
  }

  // Token expired — refresh
  try {
    console.log("Access token expired. Refreshing...");
    const tokens = await refreshAccessToken(
      creds.clientId,
      creds.clientSecret,
      creds.refreshToken
    );

    saveCredentials({
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    return tokens.access_token;
  } catch {
    // Refresh failed — re-authorize
    console.log("Refresh failed. Starting re-authorization...");
    const { clientId, clientSecret, accessToken, refreshToken } = await authorize();

    saveCredentials({
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600 * 1000,
    });

    return accessToken;
  }
}
