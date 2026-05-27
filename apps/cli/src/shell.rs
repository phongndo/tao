use std::path::PathBuf;

pub fn print_init(shell: &str) -> Result<(), String> {
    match shell {
        "zsh" => {
            print_zsh_init();
            Ok(())
        }
        "bash" => {
            print_bash_init();
            Ok(())
        }
        "fish" => {
            print_fish_init();
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(format!(
            "unsupported shell: {other} (expected zsh, bash, or fish)"
        )),
    }
}

pub fn install_init(shell: &str) -> Result<(), String> {
    match shell {
        "zsh" | "bash" | "fish" => {}
        "help" | "--help" | "-h" => {
            print_help();
            return Ok(());
        }
        other => {
            return Err(format!(
                "unsupported shell: {other} (expected zsh, bash, or fish)"
            ));
        }
    }

    let path = init_file(shell)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    let existing = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };

    let block = install_block(shell);
    let updated = if let Some(start) = existing.find(INSTALL_START) {
        let end = existing[start..]
            .find(INSTALL_END)
            .map(|index| start + index + INSTALL_END.len())
            .ok_or_else(|| {
                format!(
                    "{} has an unterminated tao integration block",
                    path.display()
                )
            })?;
        let mut value = String::new();
        value.push_str(&existing[..start]);
        value.push_str(&block);
        if existing[end..].starts_with('\n') {
            value.push_str(&existing[end + 1..]);
        } else {
            value.push_str(&existing[end..]);
        }
        value
    } else {
        let mut value = existing;
        if !value.is_empty() && !value.ends_with('\n') {
            value.push('\n');
        }
        if !value.is_empty() {
            value.push('\n');
        }
        value.push_str(&block);
        value
    };

    std::fs::write(&path, updated)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;

    println!("Installed tao shell integration in {}", path.display());
    println!("Restart your shell or run:");
    match shell {
        "fish" => println!("  source {}", path.display()),
        _ => println!("  source {}", path.display()),
    }
    Ok(())
}

pub fn print_completion(shell: &str) -> Result<(), String> {
    match shell {
        "zsh" => {
            print_zsh_completion();
            Ok(())
        }
        "bash" => {
            print_bash_completion();
            Ok(())
        }
        "fish" => {
            print_fish_completion();
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print_completion_help();
            Ok(())
        }
        other => Err(format!(
            "unsupported shell: {other} (expected zsh, bash, or fish)"
        )),
    }
}

fn print_help() {
    println!(
        "tao shell integration\n\nUSAGE:\n  tao init zsh\n  tao init bash\n  tao init fish\n  tao init <shell> --install\n\nEXAMPLES:\n  eval \"$(tao init zsh)\"\n  eval \"$(tao init bash)\"\n  tao init fish | source\n  tao init zsh --install\n\nShell integration enables auto-cd for `tao wt new` and `tao wt cd`, plus completion.\nInstall writes to the interactive shell rc file (.zshrc, .bashrc, or config.fish)."
    );
}

const INSTALL_START: &str = "# >>> tao shell integration >>>";
const INSTALL_END: &str = "# <<< tao shell integration <<<";

fn install_block(shell: &str) -> String {
    let fallback = current_exe_shell_quoted().unwrap_or_else(|| "tao".to_string());
    let command = match shell {
        "fish" => format!(
            "set -l __tao_path (type -P tao 2>/dev/null)\nif test -n \"$__tao_path\"\n  set -e TAO_BIN\n  command $__tao_path init fish | source\nelse\n  set -gx TAO_BIN {fallback}\n  command $TAO_BIN init fish | source\nend"
        ),
        "zsh" => format!(
            "if (( $+commands[tao] )); then\n  unset TAO_BIN\n  eval \"$($commands[tao] init zsh)\"\nelse\n  export TAO_BIN={fallback}\n  eval \"$($TAO_BIN init zsh)\"\nfi"
        ),
        "bash" => format!(
            "if __tao_path=\"$(type -P tao)\"; then\n  unset TAO_BIN\n  eval \"$($__tao_path init bash)\"\nelse\n  export TAO_BIN={fallback}\n  eval \"$($TAO_BIN init bash)\"\nfi\nunset __tao_path"
        ),
        _ => unreachable!("validated shell"),
    };
    format!("{INSTALL_START}\n{command}\n{INSTALL_END}\n")
}

fn current_exe_shell_quoted() -> Option<String> {
    let path = std::env::current_exe().ok()?;
    Some(shell_quote(path.to_string_lossy().as_ref()))
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    if value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '_' | '-' | ':')
    }) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn init_file(shell: &str) -> Result<PathBuf, String> {
    match shell {
        "zsh" => {
            if let Some(zdotdir) = non_empty_var("ZDOTDIR") {
                Ok(PathBuf::from(zdotdir).join(".zshrc"))
            } else {
                Ok(home_dir()?.join(".zshrc"))
            }
        }
        "bash" => Ok(home_dir()?.join(".bashrc")),
        "fish" => {
            if let Some(config_home) = non_empty_var("XDG_CONFIG_HOME") {
                Ok(PathBuf::from(config_home).join("fish").join("config.fish"))
            } else {
                Ok(home_dir()?.join(".config").join("fish").join("config.fish"))
            }
        }
        _ => Err(format!(
            "unsupported shell: {shell} (expected zsh, bash, or fish)"
        )),
    }
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

fn non_empty_var(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

fn print_completion_help() {
    println!(
        "tao completion scripts\n\nUSAGE:\n  tao completion zsh\n  tao completion bash\n  tao completion fish"
    );
}

fn print_zsh_init() {
    print_zsh_function();
    println!();
    print_zsh_completion();
}

fn print_bash_init() {
    print_bash_function();
    println!();
    print_bash_completion();
}

fn print_fish_init() {
    print_fish_function();
    println!();
    print_fish_completion();
}

fn print_zsh_function() {
    println!(
        r#"tao() {{
  case "$1:$2" in
    wt:new|worktree:new|wt:cd|worktree:cd|wt:local|worktree:local|wt:root|worktree:root|wt:switch|worktree:switch|wt:sw|worktree:sw)
      local __tao_path
      __tao_path="$(command "${{TAO_BIN:-tao}}" __shell-cd "$@")" || return $?
      if [[ -n "$__tao_path" ]]; then
        builtin cd "$__tao_path"
      fi
      ;;
    *)
      command "${{TAO_BIN:-tao}}" "$@"
      ;;
  esac
}}
"#
    );
}

fn print_bash_function() {
    println!(
        r#"tao() {{
  case "$1:$2" in
    wt:new|worktree:new|wt:cd|worktree:cd|wt:local|worktree:local|wt:root|worktree:root|wt:switch|worktree:switch|wt:sw|worktree:sw)
      local __tao_path
      __tao_path="$(command "${{TAO_BIN:-tao}}" __shell-cd "$@")" || return $?
      if [[ -n "$__tao_path" ]]; then
        builtin cd "$__tao_path"
      fi
      ;;
    *)
      command "${{TAO_BIN:-tao}}" "$@"
      ;;
  esac
}}
"#
    );
}

fn print_fish_function() {
    println!(
        r#"function tao
  switch "$argv[1]:$argv[2]"
    case wt:new worktree:new wt:cd worktree:cd wt:local worktree:local wt:root worktree:root wt:switch worktree:switch wt:sw worktree:sw
      set -l __tao_bin tao
      if set -q TAO_BIN
        set __tao_bin $TAO_BIN
      end
      set -l __tao_path (command $__tao_bin __shell-cd $argv)
      set -l __tao_status $status
      if test $__tao_status -ne 0
        return $__tao_status
      end
      if test -n "$__tao_path"
        builtin cd "$__tao_path"
      end
    case '*'
      set -l __tao_bin tao
      if set -q TAO_BIN
        set __tao_bin $TAO_BIN
      end
      command $__tao_bin $argv
  end
end
"#
    );
}

fn print_zsh_completion() {
    println!(
        r#"#compdef tao
autoload -Uz compinit
if ! (( $+functions[compdef] )); then
  compinit
fi

_tao() {{
  local -a commands wt_commands shells wt_names
  commands=(
    'tui:TUI shell for agent/worktree/review workflows'
    'review:Review-diff workflow placeholder'
    'wt:Worktree workflows'
    'worktree:Worktree workflows'
    'init:Print shell integration'
    'completion:Print completion script'
    'help:Show help'
  )
  wt_commands=(
    'new:Create a taod-managed worktree for a branch'
    'ls:List worktrees'
    'list:List worktrees'
    'cd:Select a worktree path'
    'local:Enter the local workspace checkout'
    'root:Enter the local workspace checkout'
    'switch:Switch to the worktree for the current branch'
    'sw:Switch to the worktree for the current branch'
    'path:Print a worktree path'
    'rm:Remove a worktree'
    'remove:Remove a worktree'
    'prune:Prune stale worktree metadata'
    'help:Show worktree help'
  )
  shells=('zsh:Z shell' 'bash:Bash' 'fish:Fish')

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "${{words[2]}}" in
    wt|worktree)
      if (( CURRENT == 3 )); then
        _describe 'worktree command' wt_commands
        return
      fi
      case "${{words[3]}}" in
        cd|switch|sw|path|rm|remove|delete)
          wt_names=(${{(f)"$(command "${{TAO_BIN:-tao}}" __complete wt-names 2>/dev/null)"}})
          _describe 'worktree branch' wt_names
          ;;
        new)
          _arguments '*:branch name:'
          ;;
      esac
      ;;
    init|completion)
      _describe 'shell' shells
      ;;
  esac
}}
compdef _tao tao
"#
    );
}

fn print_bash_completion() {
    println!(
        r#"_tao_complete() {{
  local cur prev words cword
  COMPREPLY=()
  cur="${{COMP_WORDS[COMP_CWORD]}}"
  prev="${{COMP_WORDS[COMP_CWORD-1]}}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "tui review wt worktree init completion help" -- "$cur") )
    return 0
  fi

  case "${{COMP_WORDS[1]}}" in
    wt|worktree)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "new ls list cd local root switch sw path rm remove delete prune help" -- "$cur") )
        return 0
      fi
      case "${{COMP_WORDS[2]}}" in
        cd|switch|sw|path|rm|remove|delete)
          COMPREPLY=( $(compgen -W "$(command "${{TAO_BIN:-tao}}" __complete wt-names 2>/dev/null)" -- "$cur") )
          return 0
          ;;
        new)
          return 0
          ;;
      esac
      ;;
    init|completion)
      COMPREPLY=( $(compgen -W "zsh bash fish" -- "$cur") )
      return 0
      ;;
  esac
}}
complete -F _tao_complete tao
"#
    );
}

fn print_fish_completion() {
    println!(
        r#"function __tao_seen_command
  set -l cmd $argv[1]
  contains -- $cmd (commandline -opc)
end

function __tao_worktree_names
  set -l __tao_bin tao
  if set -q TAO_BIN
    set __tao_bin $TAO_BIN
  end
  command $__tao_bin __complete wt-names 2>/dev/null
end

complete -c tao -f
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a tui -d 'TUI shell for agent/worktree/review workflows'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a review -d 'Review-diff workflow placeholder'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a wt -d 'Worktree workflows'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a worktree -d 'Worktree workflows'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a init -d 'Print shell integration'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a completion -d 'Print completion script'
complete -c tao -n '__fish_seen_subcommand_from init completion' -a 'zsh bash fish'
complete -c tao -n '__tao_seen_command wt; or __tao_seen_command worktree' -a 'new ls list cd local root switch sw path rm remove delete prune help'
complete -c tao -n '__tao_seen_command cd; or __tao_seen_command switch; or __tao_seen_command sw; or __tao_seen_command path; or __tao_seen_command rm; or __tao_seen_command remove; or __tao_seen_command delete' -a '(__tao_worktree_names)'
"#
    );
}
