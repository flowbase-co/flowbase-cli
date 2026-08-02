#!/usr/bin/env node

declare const __VERSION__: string;

import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAccessToken } from "./oauth.js";

const GRAPHQL_ENDPOINT = process.env.FLOWBASE_API_URL;

const COMPONENT_QUERY = `
  query Components($slug: String!, $platform: String!) {
    componentData(slug: $slug, platform: $platform) {
      data
    }
  }
`;

async function fetchComponent(name: string): Promise<object> {
  if (name.startsWith("file://")) {
    const filePath = name.replace("file://", "");
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  }

  const token = await getAccessToken();
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-App-Id": process.env.FLOWBASE_APP_ID,
    },
    body: JSON.stringify({
      query: COMPONENT_QUERY,
      variables: { slug: name, platform: "react" },
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status}\n${responseText}`);
  }

  let json: {
    data?: { componentData?: { data: string } };
    errors?: Array<{ message: string }>;
  };

  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(`Invalid JSON response: ${responseText}`);
  }

  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  if (!json.data?.componentData?.data) {
    throw new Error(`Component "${name}" not found`);
  }

  return JSON.parse(json.data.componentData.data);
}

const program = new Command();

program
  .name("flowbase")
  .description("CLI tool for installing Flowbase components")
  .version(__VERSION__);

program
  .command("add")
  .description("Install a component from Flowbase registry")
  .argument("<name>", "Component name")
  .action(async (name: string) => {
    const tmpFile = path.join(
      os.tmpdir(),
      `flowbase-${name.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.json`
    );

    try {
      console.log(`Fetching component "${name}"...`);

      const data = await fetchComponent(name);
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));

      console.log(`Installing component "${name}" via shadcn...`);
      execSync(`npx shadcn add "${tmpFile}"`, { stdio: "inherit" });

      console.log(`Component "${name}" installed successfully.`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unexpected error occurred");
      }
      process.exit(1);
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });

program
  .command("login")
  .description("Authenticate with Flowbase via OAuth")
  .action(async () => {
    try {
      await getAccessToken();
      console.log("Authentication successful.");
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unexpected error occurred");
      }
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Remove stored credentials")
  .action(() => {
    const credsPath = path.join(os.homedir(), ".flowbase", "credentials.json");
    if (fs.existsSync(credsPath)) {
      fs.unlinkSync(credsPath);
      console.log("Logged out successfully.");
    } else {
      console.log("No credentials found.");
    }
  });

program.parse();
