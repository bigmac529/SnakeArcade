/**
 * npm start helper: free the listen port, boot server.js, open the default browser.
 */
const { execSync, spawn } = require("child_process");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3023;
const URL = `http://127.0.0.1:${PORT}/`;

function log(msg) {
  console.log(`[start] ${msg}`);
}

function killPort(port) {
  if (process.platform === "win32") {
    let out = "";
    try {
      out = execSync("netstat -ano", { encoding: "utf8" });
    } catch (_) {
      return;
    }
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid) && pid !== "0") {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        log(`Stopping PID ${pid} on port ${port}`);
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } catch (_) {
        /* already gone */
      }
    }
    return;
  }

  try {
    execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
    log(`Freed port ${port} via fuser`);
  } catch (_) {
    /* no fuser or nothing listening */
  }
  try {
    const pids = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const pid of pids) {
      try {
        log(`Stopping PID ${pid} on port ${port}`);
        process.kill(Number(pid), "SIGKILL");
      } catch (_) {
        /* already gone */
      }
    }
  } catch (_) {
    /* nothing listening */
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      execSync(`cmd /c start "" "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
    log(`Opened ${url}`);
  } catch (err) {
    log(`Could not open browser automatically: ${err.message}`);
  }
}

function waitForServer(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    let left = attempts;
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        left -= 1;
        if (left <= 0) {
          reject(new Error(`Server did not become ready at ${url}`));
          return;
        }
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

killPort(PORT);

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code == null ? 1 : code);
  }
});

waitForServer(URL)
  .then(() => openBrowser(URL))
  .catch((err) => log(err.message));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch (_) {
      /* ignore */
    }
  });
}
