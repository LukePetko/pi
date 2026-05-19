import { basename } from "node:path";
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getZshPath() {
  if (process.env.PI_USER_BASH_SHELL) return process.env.PI_USER_BASH_SHELL;
  if (process.env.SHELL && basename(process.env.SHELL) === "zsh") {
    return process.env.SHELL;
  }
  return "/bin/zsh";
}

export default function (pi: ExtensionAPI) {
  const local = createLocalBashOperations();

  pi.on("user_bash", () => {
    return {
      operations: {
        exec(command, cwd, options) {
          // Fast zsh with aliases: -f skips full ~/.zshrc startup, then we load only
          // alias definitions from ~/.zshrc. `eval <command>` is needed because zsh
          // expands aliases when a command is read, after the aliases are defined.
          const zshScript = [
            `eval $(grep '^alias ' ~/.zshrc 2>/dev/null)`,
            `eval ${shellQuote(command)}`,
          ].join("\n");
          const zshCommand = `exec ${shellQuote(getZshPath())} -fc ${shellQuote(zshScript)}`;
          return local.exec(zshCommand, cwd, options);
        },
      },
    };
  });
}
