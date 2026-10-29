const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("apps/web/bootstrap.cjs", "utf8");
const environment = {
  POSTGRES_URL_FILE: "/database", BETTER_AUTH_SECRET_FILE: "/auth",
  KAN_ADMIN_API_KEY_FILE: "/admin", NEXT_PUBLIC_BASE_URL: "https://kan.example.test",
};
const files = { "/database": "postgresql://db/kan\n", "/auth": "secret\n", "/admin": "admin-key\n" };
let browserConfig = "";
let started = false;
function run() {
  vm.runInNewContext(source, {
    __dirname: "/app", process: { env: environment },
    require(name) {
      if (name === "path") return require("node:path");
      if (name === "fs") return {
        readFileSync: (filename) => files[filename], existsSync: () => true,
        mkdirSync() {}, writeFileSync: (_, text) => { browserConfig = text; },
      };
      assert.equal(name, "/app/apps/web/server.js");
      started = true;
    },
  });
}
run();
assert(started);
assert.equal(environment.POSTGRES_URL, "postgresql://db/kan");
assert.equal(environment.BETTER_AUTH_SECRET, "secret");
assert.equal(environment.KAN_ADMIN_API_KEY, "admin-key");
assert(!browserConfig.includes("admin-key"));
assert(!browserConfig.includes("postgresql"));
assert(browserConfig.includes("https://kan.example.test"));
files["/database"] = "\n";
assert.throws(run, /Empty POSTGRES_URL_FILE/);
console.log("PASS mounted secrets, empty-file refusal and private browser configuration.");
