// Landing page behaviour: theme toggle, the interactive clarification demo
// and the download list read from the latest GitHub release. Plain
// JavaScript, no build step; the markup it fills is in index.html.
(function () {
	'use strict';

	var REPO = 'aayushch/gloss';
	var REPO_URL = 'https://github.com/' + REPO;
	var RELEASES_URL = REPO_URL + '/releases';
	var LATEST_URL = RELEASES_URL + '/latest';

	function $(sel, root) {
		return (root || document).querySelector(sel);
	}
	function $$(sel, root) {
		return Array.prototype.slice.call((root || document).querySelectorAll(sel));
	}
	function esc(s) {
		return String(s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	// ---------------------------------------------------------------- theme

	var themeBtn = $('#theme');
	themeBtn.addEventListener('click', function () {
		var root = document.documentElement;
		var dark = root.getAttribute('data-mode') !== 'dark';
		if (dark) root.setAttribute('data-mode', 'dark');
		else root.removeAttribute('data-mode');
		try { localStorage.setItem('gloss-mode', dark ? 'dark' : 'light'); } catch (e) {}
	});

	// ----------------------------------------------------------------- demo
	//
	// The reply is a list of blocks (paragraphs, headings, list items). A
	// thread is a clarification attached to one block by the exact quoted
	// text; its reply blocks can carry threads of their own, two levels deep.
	// Everything is re-rendered from `state` after each change.

	var RAW = [
		{ id: 'p1', kind: 'p', md: 'That smell is a very good sign, not a bad one — it means your starter is **hungry**, not dead. Here is what is happening and how to fix it.' },
		{ id: 'h1', kind: 'h', md: 'Why it smells like nail polish remover' },
		{ id: 'p2', kind: 'p', md: 'When the yeast and bacteria in the jar run out of flour to eat, they switch to producing acetone-like compounds, and a thin grey liquid called *hooch* can collect on top. Both are the starter telling you it has been waiting too long between meals.' },
		{ id: 'h2', kind: 'h', md: 'Why it is not rising much' },
		{ id: 'li1', kind: 'li', md: '**It is underfed.** A starter that is fed once a day at room temperature usually peaks and collapses within 6–8 hours, then sits exhausted until the next feed.' },
		{ id: 'li2', kind: 'li', md: '**The kitchen is cool.** Below about 21 °C everything slows down. The same starter that doubles in 5 hours at 26 °C may take 12 at 19 °C.' },
		{ id: 'li3', kind: 'li', md: '**The ratio is too generous to the old starter.** Keeping a lot of old starter and adding a little flour means the colony is crowded and the fresh food runs out fast.' },
		{ id: 'h3', kind: 'h', md: 'What to do over the next three days' },
		{ id: 'ol1', kind: 'ol', num: 1, md: 'Pour off the hooch, then discard all but about **a tablespoon** of starter.' },
		{ id: 'ol2', kind: 'ol', num: 2, md: 'Feed it 50 g flour and 50 g lukewarm water (a 1:5:5 ratio by weight). Stir well and mark the level on the jar with a rubber band.' },
		{ id: 'ol3', kind: 'ol', num: 3, md: 'Keep it somewhere warm — inside the oven with just the light on works — and feed twice a day, morning and evening.' },
		{ id: 'p3', kind: 'p', md: 'By day two or three the smell should shift from solvent to something yoghurty and pleasantly sour, and it should reliably double between feeds. That is when it is ready to bake with.' }
	];

	// Splits a line of markdown into runs of plain, `code`, **bold** and *italic*.
	function parseInline(md) {
		var runs = [];
		var re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
		var last = 0;
		var m;
		while ((m = re.exec(md))) {
			if (m.index > last) runs.push({ t: md.slice(last, m.index) });
			var s = m[0];
			if (s[0] === '`') runs.push({ t: s.slice(1, -1), code: true });
			else if (s.indexOf('**') === 0) runs.push({ t: s.slice(2, -2), b: true });
			else runs.push({ t: s.slice(1, -1), i: true });
			last = m.index + s.length;
		}
		if (last < md.length) runs.push({ t: md.slice(last) });
		return runs;
	}
	function parseBlock(r) {
		var runs = parseInline(r.md);
		return { id: r.id, kind: r.kind, num: r.num, runs: runs, text: runs.map(function (x) { return x.t; }).join('') };
	}
	function P(md) {
		return { kind: 'p', md: md };
	}

	var PARAS = RAW.map(parseBlock);

	// Canned replies, matched against the question plus the quoted text.
	var ANSWERS = [
		[/hooch|liquid|grey|gray/i, [P('*Hooch* is mostly water and alcohol that separates out once the flour is used up. It is harmless. Pour it off for a milder flavour, or stir it back in if you like your bread more sour.')]],
		[/1:5:5|ratio|tablespoon|discard/i, [P('The three numbers are **starter : flour : water** by weight. 1:5:5 means for every 10 g of old starter you add 50 g flour and 50 g water — lots of fresh food for a small colony, so it has fuel to work through until the next feed. 1:1:1 is the common “maintenance” ratio once things are healthy.')]],
		[/oven|light|warm|21|26|19|°C|cool/i, [P('An oven light gives off just enough heat to hold the inside at roughly 24–27 °C with the door closed. Leave the oven itself off and put a sticky note on the dial so nobody preheats it with the jar inside.')]],
		[/double|peak|collapse|6–8|hours/i, [P('“Peaks” means the starter has risen as high as it will go — the surface is domed and full of bubbles. After that it runs out of food, the dome flattens and it sinks back. Baking with it right at the peak gives the best rise.')]],
		[/acetone|solvent|nail polish|smell/i, [P('When the microbes are starved they produce **ethyl acetate** and a little acetone — the same family of compounds as nail polish remover. It fades within a feed or two once the starter is eating regularly.')]],
		[/yoghurt|sour|ready|bake/i, [P('A quick test: drop a spoonful into a glass of water. If it floats, it is full of gas and ready to bake with. If it sinks, give it another feed and try again in a few hours.')]]
	];
	var FOLLOW = [P('Yes. Once the starter is healthy you can slow everything down by keeping it in the fridge and feeding it once a week — just give it two feeds at room temperature before you bake.')];

	function pad(n) {
		return String(n).length < 2 ? '0' + n : String(n);
	}
	function short(s, n) {
		n = n || 40;
		return s.length > n ? s.slice(0, n).trim() + '…' : s;
	}
	function answerFor(quote, q) {
		var h = q + ' ' + quote;
		var hit = null;
		for (var i = 0; i < ANSWERS.length; i++) if (ANSWERS[i][0].test(h)) { hit = ANSWERS[i][1]; break; }
		var blocks = hit || [P('Good question. “' + short(quote, 50) + '” is a rule of thumb rather than a hard rule — flour, water and room temperature all nudge it, so treat it as a starting point and adjust from what you see in the jar.')];
		return blocks.map(parseBlock);
	}
	function turn(q, blocks) {
		return { q: q, blocks: blocks.map(parseBlock) };
	}

	var state = {
		nextId: 3,
		composer: null, // { paraId, quote }
		ask: null, // { paraId, quote, x, y }
		threads: [
			{ id: 1, paraId: 'li1', quote: 'peaks and collapses within 6–8 hours', open: true, turns: [turn('What does “peaks” look like? How do I know when it has happened?', ANSWERS[3][1])] },
			{ id: 2, paraId: '1.0.0', quote: 'right at the peak', open: false, turns: [turn('Is there a simple test for that?', ANSWERS[5][1])] }
		]
	};
	// Block id -> parsed block, rebuilt on every render so selections can be
	// matched back to the text they were made in.
	var blocks = {};
	var scroll = $('#g-scroll');
	var body = $('#g-body');
	var askHost = $('#g-ask');
	var subs = $('#g-subs');
	var focusId = null;

	function thread(id) {
		id = Number(id);
		for (var i = 0; i < state.threads.length; i++) if (state.threads[i].id === id) return state.threads[i];
		return null;
	}
	function threadsFor(paraId) {
		return state.threads.filter(function (t) { return t.paraId === paraId; });
	}

	function runClass(r) {
		var c = [];
		if (r.code) c.push('code');
		return c.join(' ');
	}
	function wrapRun(r, html) {
		if (r.b) html = '<strong>' + html + '</strong>';
		if (r.i) html = '<em>' + html + '</em>';
		if (r.code) html = '<span class="code">' + html + '</span>';
		return html;
	}

	// Renders a block's text with its inline formatting and a mark over
	// every quote a thread (or the open composer) attached to it.
	function renderSegments(src, id) {
		var marks = threadsFor(id).map(function (t) { return { idx: src.text.indexOf(t.quote), len: t.quote.length, tid: t.id }; });
		if (state.composer && state.composer.paraId === id) marks.push({ idx: src.text.indexOf(state.composer.quote), len: state.composer.quote.length, tid: 0 });
		marks = marks.filter(function (m) { return m.idx >= 0; });
		var bounds = { 0: true };
		bounds[src.text.length] = true;
		var off = 0;
		var runAt = [];
		src.runs.forEach(function (r) { runAt.push({ s: off, e: off + r.t.length, r: r }); bounds[off] = true; off += r.t.length; });
		marks.forEach(function (m) { bounds[m.idx] = true; bounds[m.idx + m.len] = true; });
		var bs = Object.keys(bounds).map(Number).sort(function (a, b) { return a - b; });
		var html = '';
		for (var i = 0; i < bs.length - 1; i++) {
			var a = bs[i], b = bs[i + 1];
			if (b <= a) continue;
			var run = { r: {} };
			for (var j = 0; j < runAt.length; j++) if (a >= runAt[j].s && a < runAt[j].e) { run = runAt[j]; break; }
			var mark = null;
			for (var k = 0; k < marks.length; k++) if (a >= marks[k].idx && a < marks[k].idx + marks[k].len) { mark = marks[k]; break; }
			var piece = wrapRun(run.r, esc(src.text.slice(a, b)));
			html += mark ? '<mark class="mark" data-toggle="' + mark.tid + '">' + piece + '</mark>' : piece;
		}
		return html;
	}

	function renderComposer(quote, nested) {
		return '<div class="well thread">' +
			'<div class="whead"><span class="dot"></span><span class="n">' + (nested ? 'Nested clarification' : 'Clarification') + '</span><span class="re">re “' + esc(short(quote)) + '”</span></div>' +
			'<div class="composer"><textarea id="g-composer" class="iinput" rows="2" placeholder="What would you like clarified?"></textarea>' +
			'<div class="row"><button type="button" class="ibtn ibtn-primary ibtn-sm" data-send>Ask</button><button type="button" class="ibtn ibtn-sm" data-cancel>Cancel</button></div></div></div>';
	}

	function renderThread(t, depth) {
		var order = state.threads.map(function (x) { return x.id; });
		var n = pad(order.indexOf(t.id) + 1);
		var chev = '<svg class="chev' + (t.open ? ' open' : '') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="1.75" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
		var html = '<div id="g-th-' + t.id + '" class="well thread">' +
			'<button type="button" class="bare whead" data-toggle="' + t.id + '" aria-expanded="' + t.open + '"><span class="dot"></span><span class="n">Clarification ' + n + '</span><span class="re">re “' + esc(short(t.quote)) + '”</span>' +
			(depth === 1 ? '<span class="turns">' + t.turns.length + (t.turns.length === 1 ? ' turn' : ' turns') + '</span>' : '') + chev + '</button>';
		if (t.open) {
			t.turns.forEach(function (tn, ti) {
				html += '<div class="turn"><span class="wq">You</span><div class="q">' + esc(tn.q) + '</div><span class="wa">Reply</span><div class="a">';
				if (tn.pending) html += '<div class="pulse"><span></span><span></span><span></span></div>';
				(tn.blocks || []).forEach(function (b, bi) {
					var id = t.id + '.' + ti + '.' + bi;
					blocks[id] = b;
					html += '<div class="rblk" data-para="' + id + '">' + renderSegments(b, id) + '</div>';
					if (depth < 2) {
						if (state.composer && state.composer.paraId === id) html += renderComposer(state.composer.quote, true);
						threadsFor(id).forEach(function (nt) { html += renderThread(nt, depth + 1); });
					}
				});
				html += '</div></div>';
			});
			if (depth === 1) {
				html += '<div class="follow"><input id="g-th-' + t.id + '-in" class="iinput" data-follow="' + t.id + '" placeholder="Follow up in this clarification…" aria-label="Follow up"><button type="button" class="ibtn ibtn-ghost ibtn-sm" data-follow-send="' + t.id + '">Ask</button></div>';
			}
		}
		return html + '</div>';
	}

	function renderBlock(src) {
		blocks[src.id] = src;
		var html;
		if (src.kind === 'h') {
			html = '<h4 class="blk-h" data-para="' + src.id + '">' + renderSegments(src, src.id) + '</h4>';
		} else {
			html = '<div class="blk" data-para="' + src.id + '">';
			if (src.kind === 'li') html += '<span class="bullet"></span>';
			if (src.kind === 'ol') html += '<span class="num">' + src.num + '.</span>';
			html += '<div class="body">' + renderSegments(src, src.id) + '</div></div>';
		}
		if (state.composer && state.composer.paraId === src.id) html += renderComposer(state.composer.quote, false);
		threadsFor(src.id).forEach(function (t) { html += renderThread(t, 1); });
		return html;
	}

	function isNested(t) {
		return /\./.test(t.paraId);
	}

	function render() {
		blocks = {};
		var top = scroll.scrollTop;
		body.innerHTML = PARAS.map(renderBlock).join('');
		askHost.innerHTML = state.ask
			? '<button type="button" class="ibtn ibtn-primary ibtn-sm askbtn" data-ask style="left:' + state.ask.x + 'px;top:' + state.ask.y + 'px">Ask about this</button>'
			: '';
		subs.innerHTML = state.threads.map(function (t, i) {
			return '<button type="button" class="bare navitem navsub' + (isNested(t) ? ' nested' : '') + '" data-jump="' + t.id + '"><span class="dot"></span><span class="title">Clarification ' + pad(i + 1) + ' · ' + esc(short(t.quote, 24)) + '</span></button>';
		}).join('');
		$$('[data-count]').forEach(function (el) { el.textContent = state.threads.length; });
		scroll.scrollTop = top;
		if (focusId) {
			var el = document.getElementById(focusId);
			if (el) el.focus();
			focusId = null;
		}
	}

	// A selection inside one block offers the "Ask about this" button 44px
	// above its middle, clamped so it stays inside the transcript.
	scroll.addEventListener('mouseup', function (e) {
		if (e.target.closest('[data-ask]')) return;
		var sel = window.getSelection();
		var text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
		if (!text || text.length < 3) {
			if (state.ask) { state.ask = null; render(); }
			return;
		}
		var node = sel.anchorNode && (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode);
		var para = node && node.closest('[data-para]');
		var paraId = para && para.getAttribute('data-para');
		var src = paraId && blocks[paraId];
		if (!src || src.text.indexOf(text) < 0) {
			if (state.ask) { state.ask = null; render(); }
			return;
		}
		var r = sel.getRangeAt(0).getBoundingClientRect();
		var c = scroll.getBoundingClientRect();
		state.ask = {
			paraId: paraId,
			quote: text,
			x: Math.min(Math.max(r.left - c.left + r.width / 2, 80), c.width - 80),
			y: r.top - c.top + scroll.scrollTop - 44
		};
		render();
	});

	scroll.addEventListener('mousedown', function (e) {
		var ask = e.target.closest('[data-ask]');
		if (!ask) return;
		e.preventDefault();
		var a = state.ask;
		if (!a) return;
		window.getSelection().removeAllRanges();
		state.composer = { paraId: a.paraId, quote: a.quote };
		state.ask = null;
		focusId = 'g-composer';
		render();
	});

	function sendQuestion() {
		var ta = document.getElementById('g-composer');
		var q = ta && ta.value.trim();
		if (!q || !state.composer) return;
		var paraId = state.composer.paraId;
		var quote = state.composer.quote;
		var id = state.nextId++;
		state.composer = null;
		state.threads.push({ id: id, paraId: paraId, quote: quote, open: true, turns: [{ q: q, blocks: [], pending: true }] });
		render();
		reply(id, answerFor(quote, q));
	}

	function sendFollow(id) {
		var inp = document.getElementById('g-th-' + id + '-in');
		var q = inp && inp.value.trim();
		var t = thread(id);
		if (!q || !t) return;
		t.turns.push({ q: q, blocks: [], pending: true });
		render();
		reply(id, /^(can|could|should|is it|so)/i.test(q) ? FOLLOW.map(parseBlock) : answerFor(t.quote, q));
	}

	// The canned reply lands about a second later, like a fast agent would.
	function reply(id, answer) {
		setTimeout(function () {
			var t = thread(id);
			if (!t) return;
			var last = t.turns[t.turns.length - 1];
			last.pending = false;
			last.blocks = answer;
			render();
		}, 1000);
	}

	function toggleThread(id) {
		var t = thread(id);
		if (t) { t.open = !t.open; render(); }
	}

	function jumpTo(id) {
		var t = thread(id);
		if (!t) return;
		t.open = true;
		// A nested thread lives inside a parent's reply block; open that too.
		state.threads.forEach(function (p) {
			p.turns.forEach(function (tn, ti) {
				(tn.blocks || []).forEach(function (b, bi) {
					if (p.id + '.' + ti + '.' + bi === t.paraId) p.open = true;
				});
			});
		});
		render();
		var el = document.getElementById('g-th-' + id);
		if (el) scroll.scrollTo({ top: el.offsetTop - 70, behavior: 'smooth' });
	}

	scroll.addEventListener('click', function (e) {
		var el;
		if ((el = e.target.closest('[data-send]'))) return sendQuestion();
		if ((el = e.target.closest('[data-cancel]'))) { state.composer = null; render(); return; }
		if ((el = e.target.closest('[data-follow-send]'))) return sendFollow(el.getAttribute('data-follow-send'));
		if ((el = e.target.closest('[data-toggle]'))) {
			var id = el.getAttribute('data-toggle');
			if (id !== '0') toggleThread(id);
		}
	});

	scroll.addEventListener('keydown', function (e) {
		if (e.key !== 'Enter') return;
		if (e.target.id === 'g-composer' && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
		else if (e.target.hasAttribute('data-follow')) { e.preventDefault(); sendFollow(e.target.getAttribute('data-follow')); }
	});

	subs.addEventListener('click', function (e) {
		var el = e.target.closest('[data-jump]');
		if (el) jumpTo(el.getAttribute('data-jump'));
	});

	// Textareas grow with their content up to 160px.
	document.addEventListener('input', function (e) {
		if (e.target.tagName !== 'TEXTAREA' || !e.target.closest('.frame')) return;
		e.target.style.height = 'auto';
		e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
	});

	render();

	// ------------------------------------------------------------ downloads
	//
	// The latest release's assets are classified by file name; anything not
	// recognised (signatures, checksums, latest.json, source archives) is
	// left out so the page only offers builds the release really has.

	var OS_LABEL = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
	var OS_ORDER = ['macos', 'windows', 'linux'];
	var NOTES = {
		macos: 'Unsigned builds are blocked by Gatekeeper on first launch: right-click the app and choose Open.',
		windows: 'Needs WebView2, which is preinstalled on Windows 10 and 11.',
		linux: '.deb and .rpm use the system WebKitGTK; the AppImage bundles it.'
	};

	function detectOS() {
		var p = (navigator.platform || '').toLowerCase();
		var u = navigator.userAgent.toLowerCase();
		if (/mac/.test(p) || /mac os|darwin/.test(u)) return 'macos';
		if (/win/.test(p) || /windows/.test(u)) return 'windows';
		return 'linux';
	}
	function detectArch() {
		return /arm|aarch64/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'arm64' : 'x64';
	}
	function classify(name) {
		var l = name.toLowerCase();
		if (/\.(sig|sha256|json|txt|yml|zip|tar\.gz)$/.test(l)) return null;
		var arm = /aarch64|arm64/.test(l);
		if (/\.dmg$/.test(l)) return { os: 'macos', arch: arm ? 'arm64' : 'x64', archLabel: arm ? 'Apple Silicon' : 'Intel', format: 'Disk image (.dmg)', rank: 0 };
		if (/\.exe$/.test(l)) return { os: 'windows', arch: 'x64', archLabel: 'x64', format: 'Installer (.exe)', rank: 1 };
		if (/\.msi$/.test(l)) return { os: 'windows', arch: 'x64', archLabel: 'x64', format: 'MSI package', rank: 2 };
		if (/\.appimage$/.test(l)) return { os: 'linux', arch: 'x64', archLabel: 'x64', format: 'AppImage', rank: 1 };
		if (/\.deb$/.test(l)) return { os: 'linux', arch: 'x64', archLabel: 'x64', format: '.deb (Debian / Ubuntu)', rank: 2 };
		if (/\.rpm$/.test(l)) return { os: 'linux', arch: 'x64', archLabel: 'x64', format: '.rpm (Fedora / RHEL)', rank: 3 };
		return null;
	}
	function fmtSize(b) {
		return b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
	}

	var os = detectOS();
	var arch = detectArch();
	var list = $('#dl-list');
	var rows = $('#dl-rows');
	var modal = $('#dl-modal');

	function setButtons(href, label) {
		$$('[data-dl-link]').forEach(function (a) {
			a.href = href;
			if (href === LATEST_URL) a.removeAttribute('download');
			else a.setAttribute('download', '');
		});
		$$('[data-dl-label]').forEach(function (el) { el.textContent = label; });
	}
	function setVersion(version) {
		$$('[data-version]').forEach(function (el) { el.textContent = version ? 'Latest release · v' + version : 'Latest release'; });
		$$('[data-dl-sub]').forEach(function (el) { el.textContent = version ? 'Latest release · v' + version + ' · pick the build for your platform.' : 'Pick the build for your platform.'; });
	}
	function showError() {
		var msg = '<div class="status">Couldn\'t reach GitHub right now. <a href="' + LATEST_URL + '" target="_blank" rel="noopener">Open the latest release →</a></div>';
		list.innerHTML = msg;
		rows.innerHTML = rows.firstElementChild.outerHTML + msg;
		setButtons(LATEST_URL, 'Download Gloss');
		setVersion(null);
	}
	function showAssets(version, raw) {
		var assets = raw
			.map(function (a) { return { name: a.name, url: a.browser_download_url, size: a.size, meta: classify(a.name) }; })
			.filter(function (a) { return a.meta; })
			.sort(function (a, b) {
				return (a.meta.os === os ? 0 : 1) - (b.meta.os === os ? 0 : 1) ||
					OS_ORDER.indexOf(a.meta.os) - OS_ORDER.indexOf(b.meta.os) ||
					a.meta.rank - b.meta.rank;
			});
		var forOS = assets.filter(function (a) { return a.meta.os === os; });
		var rec = null;
		for (var i = 0; i < forOS.length; i++) if (forOS[i].meta.arch === arch) { rec = forOS[i]; break; }
		rec = rec || forOS[0] || null;

		setVersion(version);
		setButtons(rec ? rec.url : LATEST_URL, rec ? 'Download for ' + OS_LABEL[os] : 'Download Gloss');

		if (!assets.length) {
			list.innerHTML = '<div class="status">This release has no installers yet. <a href="' + LATEST_URL + '" target="_blank" rel="noopener">Open it on GitHub →</a></div>';
			rows.innerHTML = rows.firstElementChild.outerHTML + list.innerHTML;
			return;
		}
		list.innerHTML = assets.map(function (a) {
			return '<div class="asset' + (a === rec ? ' rec' : '') + '">' +
				'<span class="info"><span class="top">' + OS_LABEL[a.meta.os] + '<span class="mono arch">' + esc(a.meta.archLabel) + '</span>' + (a === rec ? '<span class="recl">Recommended</span>' : '') + '</span>' +
				'<span class="fmt">' + esc(a.meta.format) + (a.size ? ' · ' + fmtSize(a.size) : '') + '</span></span>' +
				'<a href="' + esc(a.url) + '" class="ibtn ibtn-sm" download>Download</a></div>';
		}).join('') + '<div class="osnote">' + esc(NOTES[os]) + '</div>';
		rows.innerHTML = rows.firstElementChild.outerHTML + assets.map(function (a) {
			return '<div class="dlrow' + (a === rec ? ' rec' : '') + '"><span class="os">' + OS_LABEL[a.meta.os] + '</span><span class="v">' + esc(a.meta.format) + '</span><span class="mono v">' + esc(a.meta.archLabel) + '</span><span class="size">' + (a.size ? fmtSize(a.size) : '—') + '</span><a href="' + esc(a.url) + '" class="ibtn ibtn-sm" download>Download</a></div>';
		}).join('');
	}

	fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
		.then(function (res) { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
		.then(function (j) { showAssets(String(j.tag_name || j.name || '').replace(/^v/, ''), j.assets || []); })
		.catch(showError);

	// -------------------------------------------------------------- modal

	var lastFocus = null;
	function openDownloads(e) {
		if (e) e.preventDefault();
		lastFocus = document.activeElement;
		modal.hidden = false;
		var close = $('[data-close-dl]', modal);
		if (close) close.focus();
	}
	function closeDownloads() {
		modal.hidden = true;
		if (lastFocus && lastFocus.focus) lastFocus.focus();
	}
	$$('[data-open-dl]').forEach(function (b) { b.addEventListener('click', openDownloads); });
	$$('[data-close-dl]').forEach(function (b) { b.addEventListener('click', closeDownloads); });
	modal.addEventListener('click', function (e) { if (e.target === modal) closeDownloads(); });
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeDownloads(); });
})();
