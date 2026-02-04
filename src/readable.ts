import type { Page } from 'playwright-core';

export interface ReadableOptions {
  selector?: string;
  maxDepth?: number;
  maxItems?: number;
  maxListItems?: number;
  maxLineLength?: number;
  filterMode?: 'summary' | 'compact' | 'full';
  links?: boolean;
  dedupe?: boolean;
  dedupeWindow?: number;
  includeFooter?: boolean;
  includeShell?: boolean;
}

export interface ReadableResult {
  text: string;
  truncated: boolean;
  stats: {
    lines: number;
    maxDepth: number;
    items: number;
  };
  links?: Array<{ ref: string; href: string }>;
}

export async function getReadableText(
  page: Page,
  options: ReadableOptions = {}
): Promise<ReadableResult> {
  const result = await page.evaluate((opts) => {
    const maxDepth = typeof opts.maxDepth === 'number' ? Math.max(0, opts.maxDepth) : 6;
    const maxItems = typeof opts.maxItems === 'number' ? Math.max(1, opts.maxItems) : Infinity;
    const maxListItems =
      typeof opts.maxListItems === 'number' ? Math.max(1, opts.maxListItems) : Infinity;
    let maxLineLength =
      typeof opts.maxLineLength === 'number'
        ? Math.max(40, opts.maxLineLength)
        : Number.POSITIVE_INFINITY;
    const filterMode = opts.filterMode || 'summary';
    const lineLimit = Number.isFinite(maxLineLength) ? maxLineLength : 300;
    const linksEnabled = opts.links !== false;
    const dedupeEnabled = opts.dedupe !== false;
    const dedupeWindow =
      typeof opts.dedupeWindow === 'number' ? Math.max(10, opts.dedupeWindow) : 120;
    const includeFooter = opts.includeFooter === true;
    const includeShell = opts.includeShell === true;

    const doc = (globalThis as { document?: any }).document;
    const win = (globalThis as { window?: any }).window;

    const preferredSelector = opts.selector || '';
    let roots: any[] = [];
    let shellRoots: any[] = [];
    if (doc) {
      if (preferredSelector) {
        const selected = Array.from(doc.querySelectorAll(preferredSelector));
        if (selected.length > 0) {
          roots = selected;
        }
      }
      if (roots.length === 0) {
        const articles = Array.from(doc.querySelectorAll('article')) as any[];
        let bestArticle: any = null;
        let bestArticleScore = -1;
        for (const article of articles) {
          const paragraphs = Array.from(article.querySelectorAll('p')) as any[];
          const paragraphText = paragraphs
            .map((p) => String((p as any).innerText || '').trim())
            .join(' ');
          const pLen = paragraphText.length;
          const pCount = paragraphs.length;
          const linkCount = article.querySelectorAll('a').length;
          const score = pLen + pCount * 200 - linkCount * 20;
          if ((pLen >= 400 || pCount >= 3) && score > bestArticleScore) {
            bestArticleScore = score;
            bestArticle = article;
          }
        }
        if (bestArticle) {
          if (Number.isFinite(maxLineLength) && maxLineLength < 360) maxLineLength = 360;
          roots = [bestArticle];
        } else {
          const candidates = [doc.querySelector('main'), doc.body].filter(Boolean);
          let best = candidates[0] || null;
          let bestScore = -1;
          for (const candidate of candidates) {
            const text = String((candidate as any).innerText || '').trim();
            const score = text.length;
            if (score > bestScore) {
              bestScore = score;
              best = candidate as any;
            }
          }
          if (best) {
            roots = [best];
          }
        }
      }
      if (includeShell) {
        shellRoots = Array.from(
          doc.querySelectorAll('header,nav,aside,[role="navigation"]')
        ) as any[];
      }
    }

    const rootSet = new Set(roots);
    if (shellRoots.length > 0) {
      shellRoots = shellRoots.filter((node) => {
        return !roots.some(
          (root) => root && typeof root.contains === 'function' && root.contains(node)
        );
      });
    }
    const shellRootSet = new Set(shellRoots);
    let shellMode = false;
    let shellRemaining = 0;
    let walkMode: 'main' | 'shell' = 'main';

    const SKIP_TAGS = new Set([
      'script',
      'style',
      'svg',
      'noscript',
      'template',
      'canvas',
      'iframe',
      'head',
      'meta',
      'link',
    ]);

    const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const HEADING_LIKE_TAGS = new Set(['summary', 'legend']);
    const BLOCK_TEXT_TAGS = new Set([
      'p',
      'blockquote',
      'pre',
      'figcaption',
      'address',
      'dd',
      'dt',
    ]);
    const CONTAINER_TAGS = new Set([
      'section',
      'article',
      'main',
      'div',
      'aside',
      'header',
      'footer',
      'form',
      'fieldset',
    ]);

    let itemCount = 0;
    let truncated = false;
    const lines: string[] = [];
    const fingerprintWindow: string[] = [];
    const fingerprintSet = new Set<string>();
    const linkMap = new Map<string, string>();
    const linkList: Array<{ ref: string; href: string }> = [];
    let linkCounter = 0;

    const normalize = (text: string) =>
      text
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const looksLikeCss = (text: string) => {
      if (!text.includes('{') || !text.includes('}')) return false;
      if (/[.#][\w-]+\s*\{[^}]*\}/.test(text)) return true;
      if (/(fill|stroke|opacity|clip-path|stroke-width)\s*:/i.test(text)) return true;
      return false;
    };

    const looksLikeCode = (text: string) => {
      if (looksLikeCss(text)) return true;
      if (/^\/\//.test(text)) return true;
      if (/^\/\*/.test(text)) return true;
      if (/\b(const|let|var|function)\b/.test(text)) return true;
      if (/[;{}]\s*$/.test(text)) return true;
      if (/\b(document|window|this)\./.test(text)) return true;
      if (/=>/.test(text)) return true;
      return false;
    };

    const cleanText = (text: string) => {
      const cleaned = normalize(text);
      if (!cleaned) return '';
      if (cleaned.replace(/[•·]/g, '').trim() === '') return '';
      if (looksLikeCode(cleaned)) return '';
      return cleaned;
    };

    const normalizeBullets = (text: string) =>
      text
        .replace(/(?:\s*•\s*){2,}/g, ' • ')
        .replace(/^\s*•\s*|\s*•\s*$/g, '')
        .trim();

    const fingerprintLine = (text: string) => {
      return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/updated\s+[^•]+/g, 'updated')
        .replace(/[•·]/g, '')
        .trim();
    };

    const decorateLine = (line: string, linkRef?: string) => {
      if (!linkRef) return line;
      if (line.startsWith('- ')) {
        return `- ${linkRef} ${line.slice(2)}`;
      }
      if (line.startsWith('#')) {
        const match = line.match(/^(#+\s*)/);
        if (match) {
          return `${match[1]}${linkRef} ${line.slice(match[1].length)}`;
        }
      }
      return `${linkRef} ${line}`;
    };

    const trimLine = (text: string) => {
      if (!Number.isFinite(maxLineLength)) return text;
      if (text.length <= maxLineLength) return text;
      return `${text.slice(0, maxLineLength - 1).trimEnd()}…`;
    };

    const addLine = (line: string, linkRef?: string) => {
      if (truncated) return;
      if (shellMode && shellRemaining <= 0) return;
      const cleaned = normalizeBullets(cleanText(line));
      if (!cleaned) return;
      const fingerprint = fingerprintLine(cleaned);
      const isHeading = cleaned.startsWith('#');
      if (dedupeEnabled && !isHeading && fingerprintSet.has(fingerprint)) return;
      if (itemCount >= maxItems) {
        truncated = true;
        return;
      }
      lines.push(trimLine(decorateLine(cleaned, linkRef)));
      itemCount += 1;
      if (shellMode) shellRemaining -= 1;
      if (dedupeEnabled) {
        fingerprintSet.add(fingerprint);
        fingerprintWindow.push(fingerprint);
        if (fingerprintWindow.length > dedupeWindow) {
          const removed = fingerprintWindow.shift();
          if (removed) fingerprintSet.delete(removed);
        }
      }
    };

    const emitHiddenHeading = (el: any) => {
      if (!el || !el.textContent) return false;
      if (el.children && el.children.length > 2) return false;
      const text = cleanText(String(el.textContent));
      if (!text || text.length > 60) return false;
      addLine(`### ${text}`);
      return true;
    };

    const isHidden = (el: any) => {
      if (el.hasAttribute('hidden')) return true;
      const ariaHidden = el.getAttribute('aria-hidden');
      if (ariaHidden === 'true') return true;
      const style = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      return false;
    };

    const shouldSkip = (el: any) => {
      if (includeFooter) return false;
      if (rootSet.has(el)) return false;
      if (shellRootSet.has(el)) return false;
      if (typeof el.closest === 'function') {
        if (el.closest('footer,[role="contentinfo"]')) return true;
        if (walkMode === 'main' && el.closest('header,nav,[role="navigation"],aside')) return true;
        if (walkMode === 'shell' && el.closest('main,article')) return true;
      }
      return false;
    };

    const registerLink = (href: string) => {
      const trimmed = href.trim();
      if (
        !trimmed ||
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('data:') ||
        trimmed.startsWith('blob:')
      )
        return undefined;
      let ref = linkMap.get(trimmed);
      if (!ref) {
        ref = `L${linkCounter + 1}`;
        linkCounter += 1;
        linkMap.set(trimmed, ref);
        linkList.push({ ref, href: trimmed });
      }
      return `@${ref}`;
    };

    const getLinkRef = (el: any) => {
      if (!linksEnabled || !el) return undefined;
      let anchor = null;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'a') {
        anchor = el;
      } else if (typeof el.querySelector === 'function') {
        anchor = el.querySelector('a[href]');
      }
      if (!anchor) return undefined;
      const href = anchor.getAttribute('href') || anchor.href;
      if (!href) return undefined;
      return registerLink(href);
    };

    const getHeadingLevel = (el: any, tag: string) => {
      if (HEADING_TAGS.has(tag)) return Number(tag.slice(1));
      if (el.getAttribute('role') === 'heading') {
        const level = Number(el.getAttribute('aria-level') || '3');
        if (Number.isFinite(level) && level > 0) return level;
      }
      return 3;
    };

    const collectInlineText = (el: any): string => {
      const parts: string[] = [];
      const childNodes = Array.from(el.childNodes || []) as any[];
      for (const node of childNodes) {
        if (node && node.nodeType === 3) {
          if (node.textContent) parts.push(node.textContent);
          continue;
        }
        if (!node || node.nodeType !== 1) continue;
        const child = node as any;
        const tag = child.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (tag === 'a') {
          const text = cleanText(String(child.textContent || ''));
          if (text) {
            const linkRef = getLinkRef(child);
            parts.push(linkRef ? `[${text}]${linkRef}` : text);
          }
          continue;
        }
        if (HEADING_TAGS.has(tag) || HEADING_LIKE_TAGS.has(tag)) continue;
        if (BLOCK_TEXT_TAGS.has(tag) || tag === 'ul' || tag === 'ol') continue;
        if (isHidden(child)) continue;
        parts.push(collectInlineText(child));
      }
      return parts.join(' ');
    };

    const extractInlineText = (el: any) => cleanText(collectInlineText(el));

    const compactText = (el: any) => {
      const raw = String(el.innerText || '');
      const parts = raw
        .split(/\n+/)
        .map((part: string) => cleanText(part))
        .filter(Boolean);
      const unique: string[] = [];
      for (const part of parts) {
        const last = unique[unique.length - 1];
        if (!last || last.toLowerCase() !== part.toLowerCase()) {
          unique.push(part);
        }
      }
      const joined = normalizeBullets(unique.join(' • '));
      return trimLine(joined);
    };

    const isStandaloneInline = (el: any) => {
      const parent = el.parentElement;
      if (!parent) return true;
      const tag = parent.tagName.toLowerCase();
      if (HEADING_TAGS.has(tag) || HEADING_LIKE_TAGS.has(tag)) return false;
      if (BLOCK_TEXT_TAGS.has(tag)) return false;
      if (tag === 'li' || tag === 'button' || tag === 'a' || tag === 'label') return false;
      return true;
    };

    const isCard = (el: any) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'article') return true;
      const role = el.getAttribute('role');
      if (role === 'article' || role === 'listitem') return true;
      const testId = el.getAttribute('data-testid') || '';
      if (testId.includes('card') || testId.includes('model')) return true;
      return false;
    };

    const hasBlockChildren = (el: any) => {
      return Array.from(el.children || []).some((child) => {
        const childTag = (child as any).tagName.toLowerCase();
        return (
          HEADING_TAGS.has(childTag) ||
          HEADING_LIKE_TAGS.has(childTag) ||
          BLOCK_TEXT_TAGS.has(childTag) ||
          childTag === 'ul' ||
          childTag === 'ol' ||
          childTag === 'li' ||
          childTag === 'article'
        );
      });
    };

    const shouldSummarizeCard = (el: any) => {
      if (!isCard(el)) return false;
      if (rootSet.has(el)) return false;
      if (hasBlockChildren(el)) return false;
      const text = cleanText(String(el.innerText || ''));
      if (text.length > lineLimit * 2) return false;
      return true;
    };

    const withShellMode = (limit: number, fn: () => void) => {
      const prevMode = shellMode;
      const prevRemaining = shellRemaining;
      const prevWalkMode = walkMode;
      shellMode = true;
      shellRemaining = limit;
      walkMode = 'shell';
      fn();
      shellMode = prevMode;
      shellRemaining = prevRemaining;
      walkMode = prevWalkMode;
    };

    const isActiveChip = (el: any) => {
      const ariaPressed = el.getAttribute('aria-pressed');
      if (ariaPressed === 'true') return true;
      const ariaSelected = el.getAttribute('aria-selected');
      if (ariaSelected === 'true') return true;
      const ariaCurrent = el.getAttribute('aria-current');
      if (ariaCurrent && ariaCurrent !== 'false') return true;
      const dataState = el.getAttribute('data-state');
      if (dataState && ['checked', 'selected', 'active'].includes(dataState)) return true;
      const className = String(el.className || '').toLowerCase();
      if (
        className.includes('active') ||
        className.includes('selected') ||
        className.includes('checked')
      )
        return true;
      return false;
    };

    const findGroupLabel = (el: any) => {
      const isLabelCandidate = (text: string) => {
        if (!text) return false;
        if (!/[A-Za-z]/.test(text) && /\d/.test(text)) return false;
        const digitCount = (text.match(/\d+/g) || []).length;
        const tokenCount = text.split(/\s+/).length;
        if (digitCount >= 3) return false;
        if (digitCount >= 2 && tokenCount >= 3) return false;
        if (/^[<>]/.test(text) && digitCount >= 1) return false;
        if (/^reset\b/i.test(text)) return false;
        return true;
      };

      const ariaLabel = cleanText(String(el.getAttribute('aria-label') || ''));
      if (ariaLabel && isLabelCandidate(ariaLabel)) return ariaLabel;

      const labelTags = new Set(['label', 'strong', 'span', 'p']);
      const isInteractive = (node: any) => {
        const tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (tag === 'button' || tag === 'a') return true;
        const role = node.getAttribute ? node.getAttribute('role') : null;
        if (role === 'button' || role === 'link') return true;
        return false;
      };

      const children = Array.from(el.children || []) as any[];
      for (const child of children) {
        const tag = (child as any).tagName.toLowerCase();
        if (HEADING_TAGS.has(tag) || HEADING_LIKE_TAGS.has(tag) || labelTags.has(tag)) {
          const text = extractInlineText(child);
          if (text && text.length <= 40 && isLabelCandidate(text)) {
            return text;
          }
        }
      }

      for (const child of children) {
        if (isInteractive(child)) continue;
        if (child.querySelector && child.querySelector('button, a, [role="button"], [role="link"]'))
          continue;
        const text = extractInlineText(child);
        if (text && text.length <= 30 && isLabelCandidate(text)) {
          return text;
        }
      }

      const descendants = Array.from(el.querySelectorAll('*')) as any[];
      for (const node of descendants) {
        if (isInteractive(node)) continue;
        if (node.querySelector && node.querySelector('button, a, [role="button"], [role="link"]'))
          continue;
        const text = extractInlineText(node);
        if (text && text.length <= 30 && isLabelCandidate(text)) {
          return text;
        }
      }

      const prev = el.previousElementSibling;
      if (prev && !isInteractive(prev)) {
        if (
          !prev.querySelector ||
          !prev.querySelector('button, a, [role="button"], [role="link"]')
        ) {
          const text = extractInlineText(prev);
          if (text && text.length <= 30 && isLabelCandidate(text)) {
            return text;
          }
        }
      }

      return null;
    };

    const extractFilterGroup = (el: any) => {
      if (!CONTAINER_TAGS.has(el.tagName.toLowerCase())) return null;
      if (rootSet.has(el)) return null;
      if (el.querySelector('h1, [role="heading"][aria-level="1"]')) return null;
      if (el.querySelector('article, table, ul, ol')) return null;

      const label = findGroupLabel(el);
      if (!label) return null;

      const children = Array.from(el.children);
      const chipNodes = Array.from(
        el.querySelectorAll('button, a, [role="button"], [role="link"]')
      ).filter((node) => node && (node as any).nodeType === 1 && !isHidden(node));

      if (chipNodes.length < 3) return null;

      const items = chipNodes.map((node) => extractInlineText(node)).filter(Boolean);
      if (items.length < 2) return null;

      const shortRatio =
        items.filter((item) => item.length <= 40).length / Math.max(items.length, 1);
      if (shortRatio < 0.7) return null;

      const activeItems = chipNodes
        .filter((node) => isActiveChip(node))
        .map((node) => extractInlineText(node))
        .filter(Boolean);

      return { label, items, activeItems };
    };

    const formatFilterGroup = (group: {
      label: string;
      items: string[];
      activeItems: string[];
    }) => {
      const cleanedItems = group.items.filter((item) => !/^reset\b/i.test(item));
      let extraCount = 0;
      const filtered = cleanedItems.filter((item) => {
        const match = item.match(/^\+\s*(\d+)$/);
        if (match) {
          extraCount += Number(match[1] || 0);
          return false;
        }
        return true;
      });
      const uniqueItems: string[] = [];
      const seen = new Set<string>();
      for (const item of filtered) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueItems.push(item);
      }

      const activeUnique = group.activeItems.filter((item) => seen.has(item.toLowerCase()));
      const remaining = uniqueItems.filter(
        (item) => !activeUnique.some((active) => active.toLowerCase() === item.toLowerCase())
      );

      let selected: string[] = [];
      if (filterMode === 'compact') {
        selected = [...activeUnique, ...remaining].slice(0, maxListItems);
      } else {
        selected = uniqueItems.slice(0, maxListItems);
      }

      if (selected.length === 0) return '';

      const remainingCount = Math.max(uniqueItems.length - selected.length, 0);
      const moreCount = remainingCount + extraCount;
      const suffix = moreCount > 0 ? ` (+${moreCount} more)` : '';

      return `${group.label}: ${selected.join(', ')}${suffix}`;
    };

    const handleList = (el: any, depth: number, listDepth: number) => {
      const items = Array.from(el.children).filter(
        (child) => (child as any).tagName.toLowerCase() === 'li'
      );
      const limit = Math.min(items.length, maxListItems);
      for (let i = 0; i < limit; i++) {
        walk(items[i], depth + 1, listDepth + 1);
        if (truncated) return;
      }
      if (items.length > limit) {
        const remaining = items.length - limit;
        addLine(`${'  '.repeat(listDepth)}- … (${remaining} more)`);
      }
    };

    const walk = (el: any, depth: number, listDepth: number) => {
      if (!el || truncated) return;
      if (depth > maxDepth) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (shouldSkip(el)) return;
      if (isHidden(el)) {
        if (emitHiddenHeading(el)) return;
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        handleList(el, depth, listDepth);
        return;
      }

      if (
        HEADING_TAGS.has(tag) ||
        HEADING_LIKE_TAGS.has(tag) ||
        el.getAttribute('role') === 'heading'
      ) {
        const text = extractInlineText(el);
        if (text) {
          const level = getHeadingLevel(el, tag);
          const prefix = '#'.repeat(Math.min(Math.max(level, 1), 6));
          addLine(`${prefix} ${text}`);
        }
        return;
      }

      if (tag === 'blockquote') {
        const text = extractInlineText(el);
        if (text) addLine(`> ${text}`);
        return;
      }

      if (tag === 'figure') {
        const captionEl = el.querySelector('figcaption');
        const caption = captionEl ? extractInlineText(captionEl) : '';
        const img = el.querySelector('img');
        const video = el.querySelector('video');
        const label = caption || (img && img.getAttribute('alt')) || 'Media';
        const src =
          (img && (img.currentSrc || img.src)) ||
          (video && (video.currentSrc || video.src || video.getAttribute('poster'))) ||
          '';
        const linkRef = src ? registerLink(src) : undefined;
        if (label) addLine(`- ${label}`, linkRef);
        return;
      }

      if (tag === 'img') {
        const alt = cleanText(String(el.getAttribute('alt') || '')) || 'Image';
        const src = el.currentSrc || el.src || '';
        const linkRef = src ? registerLink(src) : undefined;
        addLine(`- ${alt}`, linkRef);
        return;
      }

      if (tag === 'video') {
        const caption = cleanText(String(el.getAttribute('aria-label') || '')) || 'Video';
        const src = el.currentSrc || el.src || el.getAttribute('poster') || '';
        const linkRef = src ? registerLink(src) : undefined;
        addLine(`- ${caption}`, linkRef);
        return;
      }

      if (tag === 'li') {
        const text = extractInlineText(el) || compactText(el);
        const linkRef = getLinkRef(el);
        if (text) {
          addLine(`${'  '.repeat(listDepth)}- ${text}`, linkRef);
        }
        const nestedLists = Array.from(el.children).filter((child) => {
          const childTag = (child as any).tagName.toLowerCase();
          return childTag === 'ul' || childTag === 'ol';
        });
        for (const list of nestedLists) {
          walk(list, depth + 1, listDepth + 1);
        }
        return;
      }

      const group = extractFilterGroup(el);
      if (group) {
        if (filterMode !== 'full') {
          const line = formatFilterGroup(group);
          if (line) {
            addLine(`${'  '.repeat(listDepth)}- ${line}`);
          }
          return;
        }
      }

      if (shouldSummarizeCard(el)) {
        const text = compactText(el);
        const linkRef = getLinkRef(el);
        if (text) {
          addLine(`${'  '.repeat(listDepth)}- ${text}`, linkRef);
        }
        return;
      }

      if (BLOCK_TEXT_TAGS.has(tag)) {
        const text = extractInlineText(el);
        if (text) addLine(text);
        return;
      }

      if (CONTAINER_TAGS.has(tag)) {
        if (rootSet.has(el)) {
          // Avoid collapsing the entire main/root content into a single line.
        } else if (!shellMode) {
          const hasBlock = hasBlockChildren(el);
          const inlineText = extractInlineText(el);
          const childCount = Array.from(el.children).length;
          const isCompact = inlineText.length <= lineLimit && childCount <= 3;
          if (inlineText && !hasBlock && isCompact) {
            addLine(inlineText);
            return;
          }
        }
      }

      if ((tag === 'button' || tag === 'a') && isStandaloneInline(el)) {
        const text = extractInlineText(el);
        const linkRef = getLinkRef(el);
        if (text) addLine(`${'  '.repeat(listDepth)}- ${text}`, linkRef);
        return;
      }

      if (!el.children || el.children.length === 0) {
        const text = cleanText(String(el.textContent || ''));
        if (text) {
          addLine(text, getLinkRef(el));
          return;
        }
      }

      for (const child of Array.from(el.children)) {
        walk(child as any, depth + 1, listDepth);
        if (truncated) return;
      }
    };

    if (includeShell && shellRoots.length > 0) {
      withShellMode(60, () => {
        for (const root of shellRoots) {
          if (truncated) break;
          walk(root, 0, 0);
        }
      });
    }

    walkMode = 'main';
    for (const root of roots) {
      walk(root, 0, 0);
    }

    if (linksEnabled && roots.length > 0) {
      for (const root of roots) {
        const anchors = Array.from((root as any).querySelectorAll?.('a[href]') || []) as any[];
        for (const anchor of anchors) {
          const href = anchor.getAttribute('href') || anchor.href;
          if (href) registerLink(href);
        }
      }
    }
    if (linksEnabled && includeShell && shellRoots.length > 0) {
      const baseCount = linkList.length;
      const shellLinkLimit = 60;
      for (const root of shellRoots) {
        const anchors = Array.from((root as any).querySelectorAll?.('a[href]') || []) as any[];
        for (const anchor of anchors) {
          if (linkList.length - baseCount >= shellLinkLimit) break;
          const href = anchor.getAttribute('href') || anchor.href;
          if (href) registerLink(href);
        }
        if (linkList.length - baseCount >= shellLinkLimit) break;
      }
    }

    const totalChars = lines.reduce((sum, line) => sum + line.length, 0);
    if (roots.length > 0 && (lines.length < 8 || totalChars < 400)) {
      for (const root of roots) {
        const nodes = Array.from(
          (root as any).querySelectorAll?.('h2,h3,h4,p,blockquote,figcaption,li') || []
        ) as any[];

        const addNodeLine = (node: any) => {
          const tag = node.tagName.toLowerCase();
          if (tag === 'blockquote') {
            const text = extractInlineText(node);
            if (text) addLine(`> ${text}`);
            return;
          }
          if (tag === 'li') {
            const text = extractInlineText(node);
            if (text) addLine(`- ${text}`);
            return;
          }
          if (tag === 'p') {
            const text = extractInlineText(node);
            if (text) addLine(text);
            return;
          }
          if (tag === 'figcaption') {
            const text = extractInlineText(node);
            if (text) addLine(`- ${text}`);
            return;
          }
          if (HEADING_TAGS.has(tag)) {
            const text = extractInlineText(node);
            if (text) {
              const level = getHeadingLevel(node, tag);
              const prefix = '#'.repeat(Math.min(Math.max(level, 2), 6));
              addLine(`${prefix} ${text}`);
            }
            return;
          }
        };

        for (const node of nodes) {
          addNodeLine(node);
          if (truncated) break;
        }

        if (!truncated && lines.length < 8) {
          const raw = String((root as any).innerText || '');
          const segments = raw
            .split(/\n+/)
            .map((seg: string) => cleanText(seg))
            .filter(Boolean);
          for (const segment of segments) {
            const words = segment.split(/\s+/).length;
            if (words >= 4) {
              addLine(segment);
            }
          }
        }
      }
    }

    if (linksEnabled && linkList.length > 0 && !truncated) {
      addLine('### Links');
      for (const link of linkList) {
        addLine(`@${link.ref} ${link.href}`);
        if (truncated) break;
      }
    }

    return {
      text: lines.join('\n'),
      truncated,
      stats: {
        lines: lines.length,
        maxDepth,
        items: itemCount,
      },
      links: linkList,
    };
  }, options);

  return result;
}
