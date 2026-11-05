/** The new-session folder browser: a desktop double-click opens one folder, and on Windows every
 * drive is one step up from a drive's root. Run after `bun run build`. */
import "./test-herdr.ts";
import { chromiumExecutable } from "./browser.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-dirs-"));
// the folder opened and, at the same row in its own listing, the folder a second click would hit
mkdirSync(join(root, "a-open", "a-wrong"), { recursive: true });
mkdirSync(join(root, "b-other"));
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const shownPath = async (page: Page): Promise<string> => {
  await page.waitForFunction(() => document.querySelector(".dir-browser")?.getAttribute("aria-busy") === "false");
  return page.locator(".dir-browser-path").innerText();
};

try {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByRole("button", { name: /^New folder session on/ }).first().click();
  const browse = page.getByRole("button", { name: "Browse", exact: true });
  const field = page.locator("#new-session-cwd");
  // the browser opens at the folder typed
  await shownPath(page);
  await browse.click();
  await field.fill(root);
  await browse.click();
  assert.equal(await shownPath(page), root);

  // a double-click, at a person's pace: the first click opens the folder, the second lands on
  // the next listing's folder at that row and must not open it too
  const item = page.locator(".dir-browser-item", { hasText: /^a-open$/ });
  const box = (await item.boundingBox())!;
  const parentButton = page.getByRole("button", { name: "Parent folder" });
  const parentBefore = await parentButton.boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForFunction(() => document.querySelector(".dir-browser-item")?.textContent === "a-wrong");
  // a shorter listing does not move the dialog, which is centred, under the pointer
  assert.deepEqual(await parentButton.boundingBox(), parentBefore, "the browser keeps its place as the listing changes");
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  assert.equal(await shownPath(page), join(root, "a-open"), "a double-click opens the one folder clicked");
  await page.getByRole("button", { name: "Use this folder" }).click();
  assert.equal(await field.inputValue(), join(root, "a-open"));
  console.log("PASS a double-click opens the folder clicked, and that folder is picked");

  if (process.platform === "win32") {
    const up = page.getByRole("button", { name: "Parent folder" });
    const drive = parse(root).root;
    // the pick closed the browser: it opens again at the folder typed
    await field.fill(drive);
    await browse.click();
    assert.equal(await shownPath(page), drive);
    assert.equal(await up.isDisabled(), false, "a drive's root goes up, to the drives");
    // a new project folder form left open does not survive the move to the drives
    const newFolder = page.getByRole("button", { name: "New project folder" });
    await newFolder.click();
    await page.locator("#project-folder-name").waitFor();
    await up.click();
    assert.equal(await page.locator("#project-folder-name").count(), 0, "the drives close the new folder form");
    assert.equal(await newFolder.isDisabled(), true, "no folder is created among the drives");
    assert.equal(await shownPath(page), "This PC");
    const drives = await page.locator(".dir-browser-item").allInnerTexts();
    assert.ok(drives.includes(drive.toUpperCase()), `${drive} is among ${drives.join(" ")}`);
    assert.equal(await page.getByRole("button", { name: "Use this folder" }).isDisabled(), true, "the drives are no folder to pick");
    await page.locator(".dir-browser-item", { hasText: drive.toUpperCase() }).click();
    assert.equal(await shownPath(page), drive.toUpperCase());
    console.log(`PASS up from a drive's root lists this PC's drives (${drives.join(" ")}), and one opens`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
