-- The platform's own subscription invoices share the `invoice.issued` event
-- with a workspace's sales invoices. Before the posting rule learnt to tell
-- them apart, a few were posted as the workspace's sales. Remove exactly
-- those: invoice postings whose invoice is not one of this service's.
DELETE FROM journal_entries e
 WHERE e.source = 'invoice'
   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = e.source_ref AND i.org_id = e.org_id);
