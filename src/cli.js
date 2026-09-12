#!/usr/bin/env node
/**
 * SmartShop Agent — CLI
 * Usage:
 *   node src/cli.js "best laptop under $800 for coding"
 *   node src/cli.js --no-enrich "wireless headphones"
 *   node src/cli.js --web "standing desk under $400"
 */

'use strict';

require('dotenv').config();

const chalk  = require('chalk');
const ora    = require('ora');
const agent  = require('./agent/smartshop');

const BANNER = `
${chalk.cyan.bold('╔══════════════════════════════════════════════════════╗')}
${chalk.cyan.bold('║')}  ${chalk.white.bold('🛍  SmartShop AI Agent')}  ${chalk.gray('— Powered by Anakin MCP')}       ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.gray('Searches Amazon + Walmart, reasons through results,')}  ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.gray('and recommends the best product for your budget.')}    ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╚══════════════════════════════════════════════════════╝')}
`;

function printBanner() {
  console.log(BANNER);
}

function printIntentBox(intent) {
  console.log(chalk.gray('\n┌─ Query Analysis ────────────────────────────────────'));
  console.log(chalk.gray('│') + chalk.white(` Keywords : ${intent.keywords}`));
  if (intent.maxPrice) console.log(chalk.gray('│') + chalk.white(` Max Price: $${intent.maxPrice}`));
  if (intent.minPrice) console.log(chalk.gray('│') + chalk.white(` Min Price: $${intent.minPrice}`));
  console.log(chalk.gray('│') + chalk.white(` Category : ${intent.category}`));
  console.log(chalk.gray('│') + chalk.white(` Sort     : ${intent.sortPreference}`));
  console.log(chalk.gray('└─────────────────────────────────────────────────────\n'));
}

function platformBadge(platform) {
  return platform === 'amazon'
    ? chalk.yellow('🛒 Amazon')
    : chalk.blue('🏪 Walmart');
}

function printRankingRow(p, i) {
  const rankLabel = i === 0
    ? chalk.yellow.bold('🥇 Best Pick ')
    : i === 1
      ? chalk.white.bold('🥈 Runner-Up ')
      : i === 2
        ? chalk.hex('#cd7f32').bold('🥉 Third    ')
        : chalk.gray(`   #${i + 1}       `);

  const priceStr = p.price !== null
    ? chalk.green.bold(`$${p.price.toFixed(2)}`)
    : chalk.gray('N/A');

  const discStr = p.discount && p.discount > 0
    ? chalk.red(` -${p.discount}%`)
    : '';

  const ratingStr = p.rating
    ? chalk.yellow(`${p.rating.toFixed(1)}★`) + chalk.gray(` (${p.reviewCount ? p.reviewCount.toLocaleString() : '?'})`)
    : chalk.gray('No rating');

  const stockStr = p.inStock ? chalk.green('✓ In Stock') : chalk.red('✗ Out of Stock');
  const primeStr = p.prime   ? chalk.cyan(' ⚡Prime')    : '';

  const title = p.title.length > 55 ? p.title.slice(0, 52) + '…' : p.title;

  console.log(
    `${rankLabel} ${chalk.white.bold(title)}\n` +
    `           ${platformBadge(p.platform)}  ${priceStr}${discStr}  ${ratingStr}  ${stockStr}${primeStr}  ` +
    chalk.gray(`Score: ${p.score}/100`),
  );

  if (p.features.length > 0) {
    p.features.slice(0, 2).forEach(f => {
      const clean = f.replace(/\s+/g, ' ').slice(0, 90);
      console.log(`           ${chalk.gray('•')} ${chalk.gray(clean)}`);
    });
  }

  if (p.url) {
    console.log(`           ${chalk.blue.underline(p.url)}`);
  }

  console.log('');
}

function printScoreBreakdown(product) {
  const b = product.scoreBreakdown;
  console.log(chalk.gray('\n  Score breakdown for Best Pick:'));
  const bars = [
    ['Value',    b.value,    30],
    ['Rating',   b.rating,   25],
    ['Reviews',  b.reviews,  20],
    ['Features', b.features, 15],
    ['Stock',    b.stock,    10],
  ];
  bars.forEach(([label, pts, maxPts]) => {
    const pct   = Math.round((pts / maxPts) * 20);
    const bar   = '█'.repeat(pct) + '░'.repeat(20 - pct);
    const color = pts / maxPts >= 0.7 ? chalk.green : pts / maxPts >= 0.4 ? chalk.yellow : chalk.red;
    console.log(`  ${label.padEnd(9)} ${color(bar)} ${pts}/${maxPts}`);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printBanner();
    console.log(chalk.white('Usage:'));
    console.log('  node src/cli.js [options] "<your shopping query>"\n');
    console.log(chalk.white('Options:'));
    console.log('  --no-enrich    Skip product detail enrichment (faster)');
    console.log('  --no-web       Skip web search + AI summary step');
    console.log('  --json         Output raw JSON result');
    console.log('  --top <n>      Show top N results (default: 5)\n');
    console.log(chalk.white('Examples:'));
    console.log('  node src/cli.js "best laptop under $800 for coding"');
    console.log('  node src/cli.js "wireless headphones between $50 and $150"');
    console.log('  node src/cli.js --no-enrich "standing desk under $400"');
    console.log('  node src/cli.js --json "4K TV under $500"');
    console.log('  node src/cli.js --no-web --no-enrich "gaming headset"  # fastest\n');
    process.exit(0);
  }

  const noEnrich  = args.includes('--no-enrich');
  const noWeb     = args.includes('--no-web');   // opt-out flag (web is ON by default)
  const jsonMode  = args.includes('--json');
  const topIdx    = args.indexOf('--top');
  const topN      = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) || 5 : 5;

  const queryArgs = args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a));
  const query     = queryArgs.join(' ');

  if (!query) {
    console.error(chalk.red('Error: Please provide a shopping query.'));
    process.exit(1);
  }

  if (!jsonMode) printBanner();

  const spinner = jsonMode ? null : ora({
    text:    'Starting SmartShop agent…',
    spinner: 'dots',
    color:   'cyan',
  }).start();

  try {
    const emitter = await agent.run(query, {
      enrichWalmart:     !noEnrich,
      includeWebContext: !noWeb,   // DEFAULT ON — use --no-web to skip
      limit:             15,
    });

    await new Promise((resolve, reject) => {
      emitter.on('step', ({ label }) => {
        if (spinner) spinner.text = label;
      });

      emitter.on('intent', intent => {
        if (!jsonMode && spinner) {
          spinner.succeed(chalk.cyan('Query parsed'));
          printIntentBox(intent);
          spinner.start('Searching…');
        }
      });

      emitter.on('warning', msg => {
        if (!jsonMode && spinner) spinner.warn(chalk.yellow(msg));
        if (!jsonMode) spinner.start();
      });

      emitter.on('raw_counts', ({ amazon, walmart }) => {
        if (!jsonMode && spinner) {
          spinner.text = `Found ${amazon} Amazon + ${walmart} Walmart products — analysing…`;
        }
      });

      emitter.on('done', result => {
        if (spinner) spinner.stop();

        if (jsonMode) {
          console.log(JSON.stringify(result, null, 2));
          resolve();
          return;
        }

        const { intent, products, sources, durationMs } = result;

        console.log(chalk.cyan.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.white.bold(`  Results for: ${chalk.cyan('"' + intent.original + '"')}`));
        console.log(chalk.gray(`  ${sources.amazon} Amazon  +  ${sources.walmart} Walmart  →  ${products.length} ranked`));
        if (intent.maxPrice) console.log(chalk.gray(`  Budget ceiling: $${intent.maxPrice}`));
        console.log(chalk.cyan.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        const showProducts = products.slice(0, topN);
        showProducts.forEach((p, i) => printRankingRow(p, i));

        if (products.length > 0) {
          printScoreBreakdown(products[0]);
        }

        console.log(chalk.cyan.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.gray(`  Completed in ${(durationMs / 1000).toFixed(1)}s  •  Powered by Anakin MCP`));
        console.log(chalk.cyan.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        resolve();
      });

      emitter.on('error', err => {
        if (spinner) spinner.fail(chalk.red(`Agent error: ${err.message}`));
        reject(err);
      });
    });
  } catch (err) {
    if (!jsonMode) console.error(chalk.red(`\nFatal: ${err.message}`));
    process.exit(1);
  }
}

main();
