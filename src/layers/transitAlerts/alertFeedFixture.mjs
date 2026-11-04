import { PbfWriter } from 'pbf';

/** A ServiceAlerts FeedMessage with the given alerts. */
export function encodeAlerts(alerts) {
  const pbf = new PbfWriter();
  const translated = (text, language) => (_, p) =>
    p.writeMessage(1, (__, q) => {
      q.writeStringField(1, text);
      if (language) q.writeStringField(2, language);
    });
  for (const alert of alerts)
    pbf.writeMessage(2, (_, entity) => {
      entity.writeStringField(1, alert.id);
      entity.writeMessage(5, (__, a) => {
        for (const [start, end] of alert.periods || [])
          a.writeMessage(1, (___, r) => {
            if (start) r.writeVarintField(1, start);
            if (end) r.writeVarintField(2, end);
          });
        for (const stop of alert.stops || [])
          a.writeMessage(5, (___, s) => s.writeStringField(5, stop));
        if (alert.effect) a.writeVarintField(7, alert.effect);
        a.writeMessage(10, translated(alert.header, alert.language));
        if (alert.description)
          a.writeMessage(11, translated(alert.description, alert.language));
      });
    });
  return pbf.finish();
}
