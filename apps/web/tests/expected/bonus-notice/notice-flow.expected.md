startup.held cards=0 acks=0
startup.notice=赠金已到账 / 已赠送您 5.00 元 DSH 体验赠金。
startup.ack orders=22222222-2222-4222-8222-222222222222
startup.get locale=zh_CN query=
startup.ack method=POST path=/api/v0/users/ack_bonus_notified locale=zh_CN order_id=22222222-2222-4222-8222-222222222222 body="{\"order_id\":\"22222222-2222-4222-8222-222222222222\"}"
open.held cards=0 acks=1 gets=1
open.shown notice=赠金已到账 / 已赠送您 8.00 元 DSH 体验赠金。
open.shown ack orders=22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333
open.shown painted-under-settings=true cards=1 acks=2
open.get locale=zh_CN query= served=true gets=1
open.balance bonus-row=true amount=true dated=false
open.cards-while-open=1 acks=2
open.usage-link={{origin}}/usage
open.closed settings cards=1 acks=2
open.dismissed cards=0 acks=2
reopen.open gets=1 summaries=1 cards=0 acks=2
reopen.section-switch gets=0 summaries=0 amount=true cards=0 acks=2
reopen.closed cards=0 acks=2
topup.open gets=1 summaries=1
topup.returned bridge=open:top-up,close cards=0
topup.notice=赠金已到账 / 已赠送您 11.00 元 DSH 体验赠金。
topup.refresh gets=2 summaries=2 acks=1 recharge=true bonus=true
topup.closed cards=1 acks=1
retry.notice=赠金已到账 / 已赠送您 6.00 元 DSH 体验赠金。
retry.attempts=2 backoff=true body-kept=true cards=1
repeat.first=赠金已到账 / 已赠送您 7.00 元 DSH 体验赠金。
repeat.reload=赠金已到账 / 已赠送您 7.00 元 DSH 体验赠金。
repeat.shown added-storage-keys=0 reload-added=0 acks=2 cards=1
failed.links count=2 hrefs={{origin}}/usage,{{origin}}/usage
failed.reached usages=2 gets=1 summaries=1
en.notice=Bonus credited / You received a CNY 9.00 DSH trial credit.
en.get locale=en_US query=
