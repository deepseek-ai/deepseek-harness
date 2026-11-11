startup.held cards=0 acks=0
startup.notice=平台通知 / 已赠送您 5.00 元 DSH 体验赠金。
startup.ack orders=notice-first
startup.unsupported-action skipped=true valid-card=true displayed=false
startup.profile-pending notice=true displayed=1
startup.get locale=zh_CN query=
startup.ack method=POST path=/api/v0/users/notifications/events locale=zh_CN notification_id=notice-first body="{\"notification_id\":\"notice-first\",\"type\":\"displayed\"}"
startup.close event=dismissed displayed=1 dismissed=1
open.held cards=0 acks=1 gets=1
open.shown notice=赠金已到账 / 已赠送您 8.00 元 DSH 体验赠金。
open.shown ack orders=notice-first,notice-later
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
event-failed.notice=赠金已到账 / 已赠送您 6.00 元 DSH 体验赠金。
event-failed.attempts=1 body-kept=true cards=1
repeat.first=赠金已到账 / 已赠送您 7.00 元 DSH 体验赠金。
repeat.reload=赠金已到账 / 已赠送您 7.00 元 DSH 体验赠金。
repeat.shown added-storage-keys=0 reload-added=0 acks=2 cards=1
failed.links count=2 hrefs={{origin}}/usage,{{origin}}/usage
failed.reached usages=2 gets=1 summaries=1
en.notice=Bonus credited / You received a CNY 9.00 DSH trial credit.
en.get locale=en_US query=
web.notice=赠金已到账 / 已赠送您 4.00 元 DSH 体验赠金。 acks=1
stack.hidden cards=3 acks=0
stack.initial cards=3 acks=stack-first widths=260,252 inset=10 offset=-4 transition=0.25s ease-out
stack.resized sidebar=360 card=280 left-inset=10
stack.resized sidebar=280 card=260 left-inset=10
stack.rail cards=3 visible=false dismissed=0
stack.expanded cards=3 duplicate-acks=0 dismissed=0
stack.promoted cards=2 acks=stack-first,stack-second width=260 same-node=true
stack.dismissed cards=0 acks=stack-first,stack-second,stack-third
refresh.retained cards=3 acks=refresh-first same-node=true
refresh.localized locale=en_US content-reads=3 list-reads=0 acks=1 same-node=true
refresh.business-action event=cta_clicked cards=3 account-open=true
refresh.drawer width=390 notice-above-sidebar=true
refresh.action event=dismissed got-it=true
refresh.promoted cards=2 acks=refresh-first,refresh-second
refresh.dismissed cards=0 acks=refresh-first,refresh-second,refresh-third
poll.arrival cards=2 list-reads=1 duplicate-acks=0 same-node=true settings-immediate-read=true
