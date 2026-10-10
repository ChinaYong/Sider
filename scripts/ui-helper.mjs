#!/usr/bin/env node

/**
 * Sider UI 优化 - 快速命令指南
 * 
 * 使用方法：node scripts/ui-helper.mjs [命令]
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const commands = {
  'status': {
    desc: '检查当前 UI 版本状态',
    action: checkStatus
  },
  'verify': {
    desc: '验证优化文件完整性',
    action: verifyFiles
  },
  'compare': {
    desc: '对比优化前后文件大小',
    action: compareSize
  },
  'help': {
    desc: '显示帮助信息',
    action: showHelp
  }
};

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(colors[color] + msg + colors.reset);
}

function checkStatus() {
  log('\n📊 Sider UI 优化状态检查\n', 'cyan');
  
  const files = {
    'src/styles.css': '当前样式文件',
    'src/panel.html': '当前 HTML 文件',
    'src/styles.legacy.css': '原始样式备份',
    'src/panel.legacy.html': '原始 HTML 备份',
    'dist/styles.css': '构建后的样式',
    'dist/panel.html': '构建后的 HTML'
  };
  
  Object.entries(files).forEach(([file, desc]) => {
    const exists = existsSync(file);
    const icon = exists ? '✓' : '✗';
    const color = exists ? 'green' : 'red';
    const size = exists ? getSizeKB(file) : 'N/A';
    log(`  ${icon} ${desc.padEnd(20)} ${file.padEnd(30)} ${size}`, color);
  });
  
  log('\n💡 提示:', 'yellow');
  log('  • 如果构建文件缺失，运行: npm run build');
  log('  • 如果备份文件缺失，优化前的版本已被替换');
  
  log('\n📚 文档位置:', 'blue');
  log('  • 完整报告: README_UI_OPTIMIZATION.md');
  log('  • 测试指南: docs/QUICK_TEST_GUIDE.md');
  log('  • 文档索引: docs/UI_DOCS_INDEX.md\n');
}

function verifyFiles() {
  log('\n🔍 验证优化文件完整性\n', 'cyan');
  
  const checks = [
    {
      file: 'src/styles.css',
      pattern: /--surface-[0-6]:/,
      desc: '7 级色阶系统',
      expected: true
    },
    {
      file: 'src/styles.css',
      pattern: /--space-[1-7]:/,
      desc: '7 级间距令牌',
      expected: true
    },
    {
      file: 'src/styles.css',
      pattern: /--radius-(sm|md|lg|xl|full):/,
      desc: '5 级圆角系统',
      expected: true
    },
    {
      file: 'src/styles.css',
      pattern: /button\.primary/,
      desc: '主按钮样式',
      expected: true
    },
    {
      file: 'src/panel.html',
      pattern: /<link rel="stylesheet" href="styles\.css">/,
      desc: '样式表引用正确',
      expected: true
    },
    {
      file: 'src/panel.html',
      pattern: /class="primary"/,
      desc: '使用新按钮类名',
      expected: true
    }
  ];
  
  let passCount = 0;
  
  checks.forEach(check => {
    if (!existsSync(check.file)) {
      log(`  ✗ ${check.desc.padEnd(30)} (文件不存在: ${check.file})`, 'red');
      return;
    }
    
    const content = readFileSync(check.file, 'utf-8');
    const found = check.pattern.test(content);
    const pass = found === check.expected;
    
    if (pass) {
      log(`  ✓ ${check.desc.padEnd(30)}`, 'green');
      passCount++;
    } else {
      log(`  ✗ ${check.desc.padEnd(30)} (未找到预期内容)`, 'red');
    }
  });
  
  log('');
  if (passCount === checks.length) {
    log('✅ 所有检查通过！优化文件完整且正确。', 'green');
  } else {
    log(`⚠️  ${passCount}/${checks.length} 项检查通过，请检查失败项。`, 'yellow');
  }
  log('');
}

function compareSize() {
  log('\n📏 优化前后文件大小对比\n', 'cyan');
  
  const comparisons = [
    { legacy: 'src/styles.legacy.css', current: 'src/styles.css', name: '样式文件' },
    { legacy: 'src/panel.legacy.html', current: 'src/panel.html', name: 'HTML 文件' }
  ];
  
  comparisons.forEach(({ legacy, current, name }) => {
    const legacyExists = existsSync(legacy);
    const currentExists = existsSync(current);
    
    if (!legacyExists || !currentExists) {
      log(`  ⚠️  ${name}: 文件缺失，无法对比`, 'yellow');
      return;
    }
    
    const legacySize = getSize(legacy);
    const currentSize = getSize(current);
    const diff = currentSize - legacySize;
    const percent = ((diff / legacySize) * 100).toFixed(1);
    
    log(`  ${name}:`);
    log(`    优化前: ${formatSize(legacySize).padEnd(10)} ${legacy}`);
    log(`    优化后: ${formatSize(currentSize).padEnd(10)} ${current}`);
    
    const color = diff > 0 ? 'yellow' : 'green';
    const symbol = diff > 0 ? '+' : '';
    log(`    变化:   ${symbol}${formatSize(diff).padEnd(10)} (${symbol}${percent}%)`, color);
    log('');
  });
  
  log('💡 说明:', 'blue');
  log('  文件增大是因为引入了完整的设计系统和详细注释');
  log('  带来更好的可维护性和扩展性\n');
}

function showHelp() {
  log('\n📖 Sider UI 优化快速命令指南\n', 'cyan');
  
  log('用法:', 'yellow');
  log('  node scripts/ui-helper.mjs [命令]\n');
  
  log('可用命令:', 'yellow');
  Object.entries(commands).forEach(([cmd, { desc }]) => {
    log(`  ${cmd.padEnd(12)} ${desc}`);
  });
  
  log('\n常用操作:', 'yellow');
  log('  npm run build              构建扩展');
  log('  npm run preview            启动 UI 预览服务器');
  log('  npm run test               运行测试');
  log('  npm run check              测试 + 构建\n');
  
  log('快速链接:', 'blue');
  log('  完整文档: docs/UI_DOCS_INDEX.md');
  log('  测试指南: docs/QUICK_TEST_GUIDE.md');
  log('  优化报告: README_UI_OPTIMIZATION.md\n');
}

// 辅助函数
function getSize(file) {
  try {
    return readFileSync(file).length;
  } catch {
    return 0;
  }
}

function getSizeKB(file) {
  const size = getSize(file);
  return size > 0 ? `${(size / 1024).toFixed(1)} KB` : 'N/A';
}

function formatSize(bytes) {
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
}

// 主程序
const cmd = process.argv[2] || 'status';

if (commands[cmd]) {
  commands[cmd].action();
} else {
  log(`\n❌ 未知命令: ${cmd}\n`, 'red');
  showHelp();
  process.exit(1);
}
