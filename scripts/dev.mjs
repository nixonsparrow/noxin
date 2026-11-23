import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "inherit" });

  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function backendAddress(address) {
  if (address === undefined) {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      address = await terminal.question(
        "Adres backendu (http:// lub https://): ",
      );
    } finally {
      terminal.close();
    }
  }

  const target = new URL(address.trim());
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("Podaj adres bazowy HTTP lub HTTPS bez danych logowania.");
  }

  return target.href;
}

async function startFrontend(useOtherBackend, address) {
  let env = process.env;
  if (useOtherBackend) {
    env = { ...env, NOXIN_DEV_BACKEND_URL: await backendAddress(address) };
  }

  const frontend = join(workspace, "noxin-front");
  run(
    process.execPath,
    [
      join(frontend, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      useOtherBackend ? "5174" : "5173",
      "--strictPort",
      "--configLoader",
      "runner",
    ],
    { cwd: frontend, env },
  );
}

const [service, address] = process.argv.slice(2);
try {
  switch (service) {
    case "frontend":
    case "frontend-with-backend":
      await startFrontend(service === "frontend-with-backend", address);
      break;
    case "django-admin": {
      const python =
        process.platform === "win32"
          ? join(workspace, ".venv", "Scripts", "python.exe")
          : join(workspace, ".venv", "bin", "python");
      console.log("Panel Django Admin http://127.0.0.1:8002/admin/");
      run(python, ["manage.py", "runserver", "127.0.0.1:8002"], {
        cwd: workspace,
        env: { ...process.env, DEBUG: "True" },
      });
      break;
    }
    default:
      throw new Error("Wybierz polecenie startowe z głównego package.json.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
