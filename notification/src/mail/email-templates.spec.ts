import { renderTransactionalEmail } from './email-templates';

describe('renderTransactionalEmail — org_invitation kind (P8 T2.4)', () => {
  const actionUrl = 'https://app.example.test/auth/invite/tok123';

  it('renders the invite copy + accept CTA and embeds the action URL', () => {
    const out = renderTransactionalEmail({ kind: 'org_invitation', actionUrl });
    expect(out.subject).toContain('Приглашение');
    expect(out.html).toContain('Принять приглашение'); // CTA label
    expect(out.html).toContain(actionUrl); // clickable + fallback link
    expect(out.text).toContain(actionUrl);
  });

  it('HTML-escapes the action URL (defensive)', () => {
    const out = renderTransactionalEmail({
      kind: 'org_invitation',
      actionUrl: 'https://x/a?b="c"&d=<e>',
    });
    expect(out.html).not.toContain('"c"');
    expect(out.html).toContain('&quot;c&quot;');
    expect(out.html).toContain('&amp;');
  });

  it('falls back to generic copy for an unknown kind (unchanged behaviour)', () => {
    const out = renderTransactionalEmail({
      kind: 'nope' as unknown as 'generic',
      actionUrl,
    });
    expect(out.html).toContain('Открыть FairFlow');
  });
});

describe('renderTransactionalEmail — automation kind (TODO-039, machine-sent mail)', () => {
  const actionUrl = 'https://app.example.test/orders/o-42';

  it('uses the subject/title/body supplied by the automation action', () => {
    const out = renderTransactionalEmail({
      kind: 'automation',
      actionUrl: '',
      subject: 'Продажа ORD-42 завершена',
      title: 'Продажа ORD-42 завершена',
      body: 'Спасибо за покупку!',
    });
    expect(out.subject).toBe('Продажа ORD-42 завершена');
    expect(out.html).toContain('Продажа ORD-42 завершена');
    expect(out.html).toContain('Спасибо за покупку!');
    expect(out.text).toContain('Спасибо за покупку!');
  });

  it('renders no CTA and no empty fallback link when there is no action URL', () => {
    const out = renderTransactionalEmail({ kind: 'automation', actionUrl: '', body: 'Готово.' });
    // An unconditional footer used to emit `<a href="">` + a dangling
    // "Открыть FairFlow: " line for mail that has nothing to link to.
    expect(out.html).not.toContain('href=""');
    expect(out.html).not.toContain('Если кнопка не работает');
    expect(out.text).not.toContain('Открыть FairFlow: ');
    expect(out.text).toContain('отвечать на него не нужно');
  });

  it('still honours an action URL when one is provided', () => {
    const out = renderTransactionalEmail({ kind: 'automation', actionUrl, body: 'Готово.' });
    expect(out.html).toContain(actionUrl);
    expect(out.text).toContain(actionUrl);
  });
});
