# Fixed normalizer replay inputs

These six files are **synthetic ground truth**, not manually annotated real
invoices. Their expected records were designed first and the OCR strings were
rendered deterministically from those records. These fixture specifications
were authored with coding-agent assistance and fixed before the API experiments;
they are not predictions from the evaluated models or independently human-labeled
answers. Existing example fixtures informed column
layout only; company names, people, addresses, document numbers, approval
numbers and batch numbers here are fictional. These inputs contain no source
images, personal contact information, credentials or captured production OCR.

| Business | Simple | Medium | Complex |
| --- | ---: | ---: | ---: |
| `goods-receipt` | 2 rows | 8 rows | 16 rows |
| `purchase-order` | 2 rows | 8 rows | 16 rows |

Each file has one page, `pageNumber: 1`, `pageCount: 1`, and item
`sourcePages: [1]`. All item fields in the corresponding production tool schema
are present in `expected.items`, with `null` for missing data. Dates use ISO
`YYYY-MM-DD`; the explicit departure timestamp uses `YYYY-MM-DD HH:mm`.
Printed line amounts equal quantity multiplied by unit price, including
three-decimal prices; amounts are never inferred for these expected records.

Coverage:

- Every input starts with two independent rows with the same product,
  specification, manufacturer, approval number, batch and price, but different
  quantities and amounts.
- Medium and complex inputs add separate changes in batch, manufacturer and
  specification, plus multiple products and explicitly absent fields.
- Complex inputs wrap each original row into a main line and a labeled
  continuation line. Rows 15 and 16 are identical in every expected item field;
  both must remain in their printed positions. The printed sequence number is
  layout metadata, not a schema field.
- Goods receipt distinguishes packaging, quantity, actual receipt quantity and
  piece count. Only explicitly printed actual receipt quantities are non-null.
  Sales/invoice dates and the receiving address must not populate receipt times
  or the departure place. Six manual decision fields always remain null.
- Purchase order covers missing and explicit payment methods, cold-chain
  yes/no, delegated carrier, transport time limit, origin and quality status.
  `expected.header` deliberately omits `remark` and `receiptRemark`: the real
  prompt does not prescribe their free-text wording. They must not be treated as
  strict expected nulls. Goods receipt includes its prescribed
  `随货同行单号：...` remark instead.

The `—` table marker means the source supplies no value. Totals and row counts
are printed to permit independent arithmetic checks. The fictional content and
controlled layouts limit what the benchmark can establish: replay measures
normalization on these fixed texts, not image OCR accuracy or performance on
real production documents. Freeze these files across comparison arms; changing
ground truth after observing model output would invalidate the comparison.
