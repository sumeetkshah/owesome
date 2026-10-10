-- Storage deletes also require a SELECT policy, which the bucket deliberately lacks (so nobody can list
-- it); this policy never worked. Removing a receipt only detaches it from the expense.
drop policy "receipts: delete from a group folder" on storage.objects;
