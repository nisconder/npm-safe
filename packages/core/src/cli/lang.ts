import { Command } from "commander";
import { createEngine } from "./shared.js";
import { t, setLocale, getLocale, type Locale } from "./i18n.js";

export function registerLangCommand(program: Command): void {
  program
    .command("lang [locale]")
    .description("Get or set the output language (en, zh)")
    .action(async (locale?: string) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        if (!locale) {
          console.log(t("lang.current", { lang: getLocale() }));
          return;
        }

        const lc = locale.toLowerCase();
        if (lc === "en" || lc === "zh") {
          await engine.setSetting("lang", lc);
          setLocale(lc as Locale);
          console.log(t("lang.set", { lang: lc }));
        } else {
          console.error(t("lang.unknown", { locale }));
          process.exitCode = 1;
        }
      } finally {
        engine.close();
      }
    });
}
