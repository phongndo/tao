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
        "tao shell integration\n\nUSAGE:\n  tao init zsh\n  tao init bash\n  tao init fish\n\nEXAMPLES:\n  eval \"$(tao init zsh)\"\n  eval \"$(tao init bash)\"\n  tao init fish | source\n\nShell integration enables auto-cd for `tao wt new` and `tao wt cd`, plus completion."
    );
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
    wt:new|worktree:new|wt:cd|worktree:cd)
      local __tao_path
      __tao_path="$(command tao __shell-cd "$@")" || return $?
      if [[ -n "$__tao_path" ]]; then
        builtin cd "$__tao_path"
      fi
      ;;
    *)
      command tao "$@"
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
    wt:new|worktree:new|wt:cd|worktree:cd)
      local __tao_path
      __tao_path="$(command tao __shell-cd "$@")" || return $?
      if [[ -n "$__tao_path" ]]; then
        builtin cd "$__tao_path"
      fi
      ;;
    *)
      command tao "$@"
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
    case wt:new worktree:new wt:cd worktree:cd
      set -l __tao_path (command tao __shell-cd $argv)
      set -l __tao_status $status
      if test $__tao_status -ne 0
        return $__tao_status
      end
      if test -n "$__tao_path"
        builtin cd "$__tao_path"
      end
    case '*'
      command tao $argv
  end
end
"#
    );
}

fn print_zsh_completion() {
    println!(
        r#"#compdef tao
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
    'new:Create a generated-folder worktree for a branch'
    'ls:List worktrees'
    'list:List worktrees'
    'cd:Select a worktree path'
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
        cd|path|rm|remove|delete)
          wt_names=(${{(f)"$(command tao __complete wt-names 2>/dev/null)"}})
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
        COMPREPLY=( $(compgen -W "new ls list cd path rm remove delete prune help" -- "$cur") )
        return 0
      fi
      case "${{COMP_WORDS[2]}}" in
        cd|path|rm|remove|delete)
          COMPREPLY=( $(compgen -W "$(command tao __complete wt-names 2>/dev/null)" -- "$cur") )
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
  command tao __complete wt-names 2>/dev/null
end

complete -c tao -f
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a tui -d 'TUI shell for agent/worktree/review workflows'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a review -d 'Review-diff workflow placeholder'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a wt -d 'Worktree workflows'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a worktree -d 'Worktree workflows'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a init -d 'Print shell integration'
complete -c tao -n 'not __fish_seen_subcommand_from tui review wt worktree init completion help' -a completion -d 'Print completion script'
complete -c tao -n '__fish_seen_subcommand_from init completion' -a 'zsh bash fish'
complete -c tao -n '__tao_seen_command wt; or __tao_seen_command worktree' -a 'new ls list cd path rm remove delete prune help'
complete -c tao -n '__tao_seen_command cd; or __tao_seen_command path; or __tao_seen_command rm; or __tao_seen_command remove; or __tao_seen_command delete' -a '(__tao_worktree_names)'
"#
    );
}
