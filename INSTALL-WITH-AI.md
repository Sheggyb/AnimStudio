# Install AnimStudio with your AI assistant

Let an AI coding assistant (Claude Code, Cursor, VS Code with Copilot, Windsurf…) install AnimStudio and connect it to the AI through MCP for you.

**How to use it:** open your AI assistant in the folder where you keep your projects, copy everything in the box below, paste it in, and send it. The assistant asks before installing anything and tells you when to act (for example, to restart an app).

```text
Please install AnimStudio for me and connect it to you through MCP. Work step by step, check
each step before moving on, and tell me in plain words what you are doing.

ABOUT ANIMSTUDIO
- A character animation studio that runs in the browser: https://github.com/Sheggyb/AnimStudio
- A small Node.js server (server.cjs, no dependencies besides three.js) serves the app on
  http://localhost:5173 (or the next free port up to 5183; the port in use is written to the
  file ".port" in the AnimStudio folder).
- mcp/server.mjs is a stdio MCP server (no install needed) that lets you control the open app.
  It finds the running AnimStudio by itself. It only works while AnimStudio is running AND its
  page is open in a browser tab: the tab carries out the commands.

RULES
- Ask me before installing any software (Node.js, Git) and before changing any config file.
- Never run anything as administrator / with sudo unless I agree.
- When you edit an MCP config file, keep everything that is already in it: add the
  "animstudio" entry, don't replace the file. Make a backup copy first.
- Don't download characters or animations for me. AnimStudio comes without them on purpose;
  I add my own (see step 7).

STEPS
1. Check the tools: run `node --version` (needs 18 or newer) and `git --version`.
   - Node missing or too old: ask me, then install the LTS version (Windows:
     `winget install OpenJS.NodeJS.LTS`; macOS: `brew install node`; Linux: the
     distribution's package or https://nodejs.org). A new terminal may be needed afterwards.
   - Git missing: ask me, then install it (Windows: `winget install Git.Git`; macOS:
     `xcode-select --install` or `brew install git`), or download the ZIP from GitHub instead.
2. Get AnimStudio: `git clone https://github.com/Sheggyb/AnimStudio.git` in the folder I'm in
   (if an AnimStudio folder already exists, use it and run `git pull` instead). Remember the
   FULL absolute path of the AnimStudio folder; the MCP config needs it.
3. Install: in the AnimStudio folder run `npm install`.
4. Test (optional but quick): `npm test`. Tests that say "skipped" are fine: they need
   animation files I haven't added yet. There must be 0 failed.
5. Start AnimStudio and keep it running:
   - Windows: I can double-click start.bat. If you start it yourself, run `npm start` in a
     separate/background terminal that stays open (it does not exit on its own).
   - macOS/Linux: `npm start` in a terminal that stays open.
   - It opens the browser by itself. If not, open the URL it prints (http://localhost:5173 or
     the port in ".port").
   - Check: the page shows "AnimStudio" with "My characters" and "Animation packs".
   - Only ONE AnimStudio may run. If 5173 is taken by an older AnimStudio, use that one
     instead of starting another.
6. Connect the MCP server for the AI app I'm using right now (ask me which one if unsure).
   Use the absolute path from step 2 (written <ABS> below; on Windows use forward slashes,
   e.g. C:/Users/me/AnimStudio).
   - Claude Code: run `claude mcp add --scope user animstudio -- node "<ABS>/mcp/server.mjs"`
     (or, when working inside the AnimStudio folder, its .mcp.json already registers it:
     approve "animstudio" when asked). Check with `claude mcp list`.
   - Claude Desktop: config file is
       Windows: %APPDATA%\Claude\claude_desktop_config.json
       macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
     (create it if missing). Inside "mcpServers" add:
       "animstudio": { "command": "node", "args": ["<ABS>/mcp/server.mjs"] }
     Then I must quit Claude Desktop completely (also from the tray) and start it again.
   - Cursor: ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project), same
     "mcpServers" entry as Claude Desktop. Then check it under Settings > MCP.
   - VS Code: .vscode/mcp.json in the workspace (or the user-level MCP config):
       { "servers": { "animstudio": { "type": "stdio", "command": "node",
         "args": ["<ABS>/mcp/server.mjs"] } } }
   - Other MCP apps: a stdio server, command `node`, argument `<ABS>/mcp/server.mjs`.
   - If AnimStudio runs on a different port and isn't found, add
     "env": { "ANIMSTUDIO_PORT": "<port>" } next to "args".
   - Most apps load MCP servers only at start: tell me to restart the app (or start a new
     session) when that is needed, and continue after I say it's done.
7. Verify: with AnimStudio's tab open, call the animstudio `status` tool and tell me what it
   reports. If the tools aren't available yet, tell me to restart the AI app.
   Quick server check without MCP: GET http://localhost:<port>/api/bridge/status should return
   {"connected":1} (1 = the AnimStudio tab is open and listening).
8. Finish with a short summary: where AnimStudio is installed, how I start it next time
   (start.bat / npm start), which AI app is connected, and these next steps for me:
   - Drop my character (.glb or .fbx) on AnimStudio's start page. No skeleton? Tools > Build
     skeleton.
   - Add animations: on the start page press "+ Add animations" and pick my downloads:
     Mixamo .fbx files (mixamo.com, free account: Format FBX, 30 fps, "In Place" for walks
     and runs) or .glb packs such as Quaternius' free "Universal Animation Library".
   - Then ask you things like "give my character a heavier run" or "make a 2-second sword
     swing", and watch it happen in the viewport.

TROUBLESHOOTING
- "AnimStudio is not running": start it (step 5) and keep its browser tab open.
- Tools missing: restart the AI app; check the path to mcp/server.mjs and that `node` works.
- Commands go to the wrong window: two AnimStudios are running; close the extra console and tab.
- After updating AnimStudio (`git pull`): press F5 in its tab; restart the AI app if new tools
  were added.
- More help: README.md in the AnimStudio folder, section "Control AnimStudio with AI (MCP)".
```

Prefer to do it yourself? The [README](README.md#start) has the same steps by hand.
