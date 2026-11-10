// ENTSO-E answers for tests, shaped like the Transparency Platform's XML.

/**
 * One TimeSeries: `points` are [position, quantity] pairs.
 * @param {{start: string, end: string, resolution?: string, curve?: string,
 *   inArea?: string, outArea?: string, psrType?: string,
 *   domain?: 'zone'|'flow', points: Array<[number, number]>}} options
 */
export function entsoeSeries({
  start,
  end,
  resolution = 'PT15M',
  curve = 'A01',
  inArea,
  outArea,
  psrType,
  domain = 'zone',
  points,
}) {
  const area = (side, code) =>
    code
      ? domain === 'flow'
        ? `<${side}_Domain.mRID codingScheme="A01">${code}</${side}_Domain.mRID>`
        : `<${side}BiddingZone_Domain.mRID codingScheme="A01">${code}</${side}BiddingZone_Domain.mRID>`
      : '';
  return `<TimeSeries>
    <mRID>1</mRID>
    ${area('in', inArea)}
    ${area('out', outArea)}
    ${psrType ? `<MktPSRType><psrType>${psrType}</psrType></MktPSRType>` : ''}
    <curveType>${curve}</curveType>
    <Period>
      <timeInterval><start>${start}</start><end>${end}</end></timeInterval>
      <resolution>${resolution}</resolution>
      ${points
        .map(
          ([position, quantity]) =>
            `<Point><position>${position}</position><quantity>${quantity}</quantity></Point>`,
        )
        .join('')}
    </Period>
  </TimeSeries>`;
}

/** A whole answer around some series. */
export function entsoeDocument(series) {
  return `<?xml version="1.0" encoding="utf-8"?>
<GL_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0">
  <mRID>test</mRID>
  ${series.join('\n')}
</GL_MarketDocument>`;
}

/** ENTSO-E's acknowledgement for a query that matched nothing (or `code`). */
export function entsoeAcknowledgement(
  code = '999',
  text = 'No matching data found',
) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Acknowledgement_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:7:0">
  <mRID>ack</mRID>
  <Reason><code>${code}</code><text>${text}</text></Reason>
</Acknowledgement_MarketDocument>`;
}
