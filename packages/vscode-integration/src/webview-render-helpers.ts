/**
 * Production webview rendering helpers.
 *
 * Authority & Safety Model:
 *   Untrusted text (chat content, terminal output/command, confirmation summary,
 *   risk labels, file paths) is rendered strictly via `element.textContent = text`.
 *   Containers are cleared via `element.innerHTML = ''`.
 *   Zero script execution, zero event handler execution, zero unsafe navigation.
 *
 * This implementation is authoritative and shared between:
 *   - The shipped webview script runtime in `ChatViewProvider`
 *   - Production security evaluations and E2E rendering verification
 */

export function renderChatMessage(
  container: any,
  message: { role?: string; content: string } | string,
  doc?: any
): any {
  const d = doc || (typeof (globalThis as any).document !== 'undefined' ? (globalThis as any).document : undefined);
  const div = d.createElement('div');
  const role = typeof message === 'object' && message && message.role ? message.role : 'user';
  const content = typeof message === 'object' && message ? (message.content ?? '') : String(message ?? '');
  div.className = 'message ' + role;
  div.textContent = content;
  container.appendChild(div);
  return div;
}

export function renderTerminalOutput(
  container: any,
  term: any,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  container.innerHTML = '';
  if (!term) return null;

  const d = doc || (typeof (globalThis as any).document !== 'undefined' ? (globalThis as any).document : undefined);
  const card = d.createElement('div');
  card.className = 'terminal-card';

  const title = d.createElement('div');
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '5px';
  title.textContent = 'Controlled Terminal Execution (' + term.status + ')';
  card.appendChild(title);

  const meta = d.createElement('div');
  meta.className = 'terminal-meta';
  meta.textContent = 'CWD: ' + term.cwd + ' | Provenance: ' + term.provenance + ' | Timeout: ' + (term.timeoutMs / 1000) + 's';
  card.appendChild(meta);

  const cmdBox = d.createElement('div');
  cmdBox.className = 'terminal-command-box';
  cmdBox.textContent = term.command;
  card.appendChild(cmdBox);

  if (term.exitCode !== undefined && term.exitCode !== null) {
    const resultLine = d.createElement('div');
    resultLine.className = 'terminal-meta';
    resultLine.textContent = 'Finished with code ' + term.exitCode + (term.durationMs ? ' (' + term.durationMs + 'ms)' : '');
    card.appendChild(resultLine);
  }

  if (term.isOutputVisible) {
    const outBox = d.createElement('div');
    outBox.className = 'terminal-output-box';
    let text = '';
    if (term.stdout) text += term.stdout;
    if (term.stderr) text += (text ? '\n--- STDERR ---\n' : '') + term.stderr;
    outBox.textContent = text || '(No output)';
    card.appendChild(outBox);

    if (term.stdoutTruncated || term.stderrTruncated) {
      const truncWarn = d.createElement('div');
      truncWarn.className = 'truncation-warning';
      truncWarn.textContent = '[Output bounded and truncated at limit]';
      card.appendChild(truncWarn);
    }
  }

  const actions = d.createElement('div');
  actions.className = 'confirmation-actions';

  const btnToggle = d.createElement('button');
  btnToggle.className = 'btn-reject';
  btnToggle.textContent = term.isOutputVisible ? 'Hide Output' : 'Show Output';
  if (postMessage && btnToggle.addEventListener) {
    btnToggle.addEventListener('click', () => {
      postMessage({ type: 'terminal.toggleOutput', executionId: term.executionId });
    });
  }
  actions.appendChild(btnToggle);

  const btnCopy = d.createElement('button');
  btnCopy.className = 'btn-reject';
  btnCopy.textContent = 'Copy Command';
  if (postMessage && btnCopy.addEventListener) {
    btnCopy.addEventListener('click', () => {
      postMessage({ type: 'terminal.copyCommand', executionId: term.executionId });
    });
  }
  actions.appendChild(btnCopy);

  if (term.status === 'RUNNING') {
    const btnCancel = d.createElement('button');
    btnCancel.className = 'btn-reject';
    btnCancel.textContent = 'Cancel';
    if (postMessage && btnCancel.addEventListener) {
      btnCancel.addEventListener('click', () => {
        postMessage({ type: 'terminal.cancel', executionId: term.executionId });
      });
    }
    actions.appendChild(btnCancel);
  }

  card.appendChild(actions);
  container.appendChild(card);
  return card;
}

export function renderConfirmationSummary(
  container: any,
  conf: any,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  container.innerHTML = '';
  if (!conf) return null;

  const d = doc || (typeof (globalThis as any).document !== 'undefined' ? (globalThis as any).document : undefined);
  const div = d.createElement('div');
  div.className = 'confirmation-card';

  const title = d.createElement('div');
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '5px';
  title.textContent = conf.riskLabel || 'Approval Required';

  const summary = d.createElement('div');
  summary.style.fontSize = '0.9em';
  summary.style.marginBottom = '10px';
  summary.textContent = conf.summary;

  const actions = d.createElement('div');
  actions.className = 'confirmation-actions';

  const btnReject = d.createElement('button');
  btnReject.className = 'btn-reject';
  btnReject.id = 'btn-reject';
  btnReject.textContent = 'Reject';

  const btnApprove = d.createElement('button');
  btnApprove.className = 'btn-approve';
  btnApprove.id = 'btn-approve';
  btnApprove.textContent = conf.preparedCommand ? 'Run' : 'Approve';

  let btnDiff: any = null;
  if (conf.mutationId) {
    btnDiff = d.createElement('button');
    btnDiff.className = 'btn-reject';
    btnDiff.id = 'btn-diff';
    btnDiff.textContent = 'Open Diff';
    actions.appendChild(btnDiff);
  }

  actions.appendChild(btnReject);
  actions.appendChild(btnApprove);

  div.appendChild(title);
  div.appendChild(summary);
  div.appendChild(actions);

  container.appendChild(div);

  if (postMessage) {
    if (btnDiff && btnDiff.addEventListener) {
      btnDiff.addEventListener('click', () => {
        postMessage({ type: 'ui.openDiff', mutationId: conf.mutationId, path: conf.path || 'unknown', isCreate: conf.type === 'create' });
      });
    }
    if (btnApprove.addEventListener) {
      btnApprove.addEventListener('click', () => {
        const msgType = conf.preparedCommand ? 'terminal.respond' : 'confirmation.respond';
        postMessage({ type: msgType, confirmationId: conf.id, action: 'APPROVE' });
      });
    }
    if (btnReject.addEventListener) {
      btnReject.addEventListener('click', () => {
        const msgType = conf.preparedCommand ? 'terminal.respond' : 'confirmation.respond';
        postMessage({ type: msgType, confirmationId: conf.id, action: 'REJECT' });
      });
    }
  }

  return div;
}
