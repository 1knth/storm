const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const LOCAL_FRAGMENT = /^#[\w.-]+$/;

/** Keep local SVG paint-server references, but never external CSS resources. */
export function hasExternalCssReference(css: string): boolean {
  if (/@import\b|@font-face\b/i.test(css)) return true;
  if (/[\\\\/*]/.test(css)) return true;

  CSS_URL.lastIndex = 0;
  for (const match of css.matchAll(CSS_URL)) {
    if (!LOCAL_FRAGMENT.test(match[2].trim())) return true;
  }
  return false;
}

/** Remove external CSS references without rewriting or trusting their contents. */
export function sanitizeSvgReferences(svg: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror')) return '';

  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);

  for (const element of elements) {
    if (element.localName === 'style') {
      if (hasExternalCssReference(element.textContent ?? '')) element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      if (
        (attribute.name.toLowerCase() === 'style' ||
          /url\s*\(/i.test(attribute.value)) &&
        hasExternalCssReference(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const serializer = new XMLSerializer();
  return serializer.serializeToString(document.documentElement);
}
