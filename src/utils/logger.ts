import chalk from 'chalk';

export const logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ ') + chalk.white(msg)),
  success: (msg: string) => console.log(chalk.green('✔ ') + chalk.bold.green(msg)),
  warn: (msg: string) => console.log(chalk.yellow('⚠ ') + chalk.yellow(msg)),
  error: (msg: string, err?: any) => {
    console.log(chalk.red('✖ ') + chalk.bold.red(msg));
    if (err) console.error(chalk.red(err?.stack || err?.message || err));
  },
  agent: (msg: string) => console.log(chalk.magenta('🤖 [Agent]: ') + chalk.white(msg)),
  tool: (name: string, details?: string) => {
    console.log(chalk.cyan(`⚡ [Tool Execution: ${name}]`) + (details ? chalk.gray(`: ${details}`) : ''));
  },
  query: (type: string, queryStr: string) => {
    console.log(chalk.yellowBright(`📊 [MongoDB ${type}]: `) + chalk.cyan(queryStr));
  },
  result: (summary: string) => console.log(chalk.gray('  ↳ Result: ') + chalk.dim(summary)),
  divider: () => console.log(chalk.dim('─'.repeat(60)))
};
