#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { chatCommand } from './commands/chat';
import { configCommand } from './commands/config';
import { registerSkillCommand } from './commands/skill';
import { feishuCommand } from './commands/feishu';
import { runtimeCommand } from './commands/runtime';
import { evalCommand } from './commands/eval';
import { APP_VERSION } from './version';

function main() {
  const program = new Command();

  if (process.argv[2] !== 'eval') {
    Logger.brand();
  }

  program
    .name('catsco')
    .description('CatsCo agent CLI')
    .version(APP_VERSION);

  program
    .command('chat')
    .description('Start a CatsCo local chat session')
    .option('-i, --interactive', 'Enter interactive mode')
    .option('-m, --message <message>', 'Send a single message')
    .action(chatCommand);

  program
    .command('eval')
    .description('Run a non-interactive CatsCo coding evaluation turn')
    .requiredOption('--cwd <path>', 'Repository working directory for tools')
    .option('--prompt-file <path>', 'Read the evaluation prompt from a file')
    .option('-m, --message <message>', 'Use an inline evaluation prompt')
    .option('--session-key <key>', 'Isolated session key for this case')
    .option('--run-root <path>', 'Isolated runtime/log root for this case')
    .option('--env-file <path>', 'Load model/API environment variables from a file')
    .option('--model-source <source>', 'Model profile to use: env, custom, or relay', 'env')
    .option('--output-json <path>', 'Write a machine-readable result JSON file')
    .option('--max-minutes <minutes>', 'Maximum wall-clock time before interrupting the turn', '20')
    .option('--auto-approve-tools [tools]', 'Comma-separated local tool names to auto-approve')
    .option('--no-interactive', 'Compatibility flag for benchmark runners')
    .option('--no-dashboard', 'Compatibility flag for benchmark runners')
    .action(evalCommand);

  program
    .command('config')
    .description('Configure CatsCo API settings')
    .action(configCommand);

  program
    .command('feishu')
    .description('Start the Feishu bot')
    .action(feishuCommand);

  program
    .command('catscompany')
    .description('Start the CatsCo agent connector (legacy alias)')
    .action(async () => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand();
    });

  program
    .command('connect')
    .description('Start the CatsCo webapp connector')
    .action(async () => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand();
    });

  program
    .command('catsco')
    .description('Start the CatsCo webapp connector (compatibility alias)')
    .action(async () => {
      const { catscompanyCommand } = await import('./commands/catscompany');
      await catscompanyCommand();
    });

  program
    .command('weixin')
    .description('Start the Weixin bot')
    .action(async () => {
      const { weixinCommand } = await import('./commands/weixin');
      await weixinCommand();
    });

  program
    .command('dashboard')
    .description('Start the CatsCo Dashboard')
    .option('-p, --port <port>', 'Specify the port number', '3800')
    .action(async (options) => {
      const { dashboardCommand } = await import('./commands/dashboard');
      await dashboardCommand(options);
    });

  program
    .command('runtime')
    .description('Show the resolved node, python, and git runtimes')
    .action(runtimeCommand);

  registerSkillCommand(program);

  program.action(() => {
    chatCommand({ interactive: true });
  });

  program.parse();
}

main();
