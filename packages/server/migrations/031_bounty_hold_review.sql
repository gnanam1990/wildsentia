-- Congo 1D review: an admin who resumes a bounty held for an outage has reviewed it; it is then
-- decided normally, without being held again for the same outage.
alter table bounties add column hold_cleared boolean not null default false;
